
import { common } from '@kit.AbilityKit'
import { systemDateTime } from '@kit.BasicServicesKit'
import { DMPAppConfig } from './config/DMPAppConfig'
import { DMPApp } from './DMPApp'
import { DMPLogger } from '../EventTrack/DMPLogger'
import { Tags } from '../EventTrack/Tags'
import { DMPContextUtils } from '../Utils/DMPContextUtils'
import { DMPRawFileUtils } from '../Utils/DMPRawFileUtils'
import { DMPMap } from '../Utils/DMPMap'
import { DMPLaunchConfig, DMPOpenType, DMPScene } from './config/DMPLaunchConfig'
import {
  DMPMiniProgramPathParser,
  DMPMiniProgramPresentationStack
} from './DMPMiniProgramPresentationStack'
import { DMPRemoteUpdateManager, DMPMiniProgramVersionInfo } from '../Bundle/DMPRemoteUpdateManager'
import { DMPMMKVManager } from '../Bundle/Util/DMPMMKVManager'
import { DMPPreference } from '../Utils/DMPPreference'

export type DMPMiniProgramBeforeDestructiveAction = () => Promise<void>

class DMPResolvedMiniProgramConfig {
  appConfig: DMPAppConfig
  entryPath: string

  constructor(appConfig: DMPAppConfig, entryPath: string) {
    this.appConfig = appConfig
    this.entryPath = entryPath
  }
}

export class DMPRetentionPolicy {
  maxBackgroundApps: number
  backgroundTimeoutMs: number

  constructor(maxBackgroundApps: number = 3, backgroundTimeoutMs: number = 300000) {
    if (!Number.isSafeInteger(maxBackgroundApps) || maxBackgroundApps < 0 ||
      !Number.isSafeInteger(backgroundTimeoutMs) || backgroundTimeoutMs < 0) {
      throw new Error('Retention limits must be non-negative safe integers')
    }
    this.maxBackgroundApps = maxBackgroundApps
    this.backgroundTimeoutMs = backgroundTimeoutMs
  }
}

export class DMPAppManager {
  private static instance: DMPAppManager
  appPools = new Map<number, DMPApp>();
  private appIndex = 0;
  private miniProgramPresentations = new DMPMiniProgramPresentationStack()
  private miniProgramOperationInProgress = false
  // 宿主自己的前后台状态，由 DMPAppLifecycle 的 windowStage 事件维护。跨小程序恢复 opener
  // 时要看它，而不是看「谁在展示」——后者在宿主后台里同样会变。
  private hostVisible = true
  private destroyingAllMiniPrograms = false

  isDestroyingAllMiniPrograms(): boolean { return this.destroyingAllMiniPrograms }

  /** Destroy all live/retained instances. Packages and persistent user data are retained. */
  async destroyAllMiniPrograms(): Promise<void> {
    if (this.miniProgramOperationInProgress) {
      throw new Error('destroyAllMiniPrograms:fail another mini program operation is in progress')
    }
    this.miniProgramOperationInProgress = true
    this.destroyingAllMiniPrograms = true
    const apps = Array.from(this.appPools.values())
    // Follow actual presentation order, which need not match instance creation order.
    const ordered: DMPApp[] = []
    while (this.miniProgramPresentations.top()) {
      const top = this.miniProgramPresentations.top()!
      const app = this.appPools.get(top.appIndex)
      if (app) ordered.push(app)
      this.miniProgramPresentations.pop(top.appIndex)
    }
    apps.forEach((app: DMPApp): void => { if (!ordered.includes(app)) ordered.push(app) })
    this.retentionRevision++
    if (this.retentionTimer !== -1) clearTimeout(this.retentionTimer)
    this.retentionTimer = -1
    this.retainedSince.clear()
    this.retentionPressure = false
    let failure: Error | undefined
    try {
      for (const app of ordered) {
        try {
          await app.closeDimina()
        } catch (error) {
          // Still attempt every owner; report incomplete cleanup to the host.
          failure = failure ?? error as Error
        }
      }
      if (failure) throw failure
    } finally {
      this.destroyingAllMiniPrograms = false
      this.endMiniProgramOperation()
    }
  }
  private memoryObserver: number = -1

  observeMemoryPressure(context: common.UIAbilityContext): void {
    if (this.memoryObserver !== -1) return
    this.memoryObserver = context.getApplicationContext().on('environment', {
      onConfigurationUpdated: (): void => {},
      onMemoryLevel: (): void => this.notifyMemoryPressure()
    })
  }

  private retentionPolicy = new DMPRetentionPolicy()
  private retainedSince = new Map<number, number>()
  private retentionTimer: number = -1
  private retentionQueued: boolean = false
  private retentionRevision: number = 0
  private retentionPressure: boolean = false

  configureRetention(policy: DMPRetentionPolicy): void {
    this.retentionPolicy = new DMPRetentionPolicy(policy.maxBackgroundApps, policy.backgroundTimeoutMs)
    this.scheduleRetention()
  }

  /** Forward UIAbility.onMemoryLevel here; all evictable background instances are released. */
  notifyMemoryPressure(): void {
    this.retentionPressure = true
    this.scheduleRetention()
  }

  retentionVisibility(app: DMPApp, visible: boolean): void {
    if (visible) {
      if (!this.retainedSince.delete(app.appIndex)) return
    } else {
      if (this.retainedSince.has(app.appIndex)) return
      this.retainedSince.set(app.appIndex, systemDateTime.getUptime(systemDateTime.TimeType.STARTUP, false))
    }
    this.scheduleRetention()
  }

  private scheduleRetention(): void {
    this.retentionRevision++
    if (this.retentionTimer !== -1) clearTimeout(this.retentionTimer)
    this.retentionTimer = -1
    if (this.retentionQueued) return
    this.retentionQueued = true
    Promise.resolve().then(async (): Promise<void> => {
      this.retentionQueued = false
      await this.collectRetainedApps()
    }).catch((error: Error): void => {
      DMPLogger.e(Tags.LAUNCH, `retention: ${error.message}`)
    })
  }

  async collectRetainedApps(): Promise<void> {
    if (this.retentionTimer !== -1) clearTimeout(this.retentionTimer)
    this.retentionTimer = -1
    if (this.miniProgramOperationInProgress) return
    const revision = this.retentionRevision
    const candidates: number[] = []
    this.retainedSince.forEach((_since: number, index: number): void => {
      const app = this.appPools.get(index)
      if (!app) this.retainedSince.delete(index)
      else if (app.navigatorManager.isRetainedInBackground) candidates.push(index)
    })
    candidates.sort((a: number, b: number): number =>
      (this.retainedSince.get(a)! - this.retainedSince.get(b)!) || a - b)
    const now = systemDateTime.getUptime(systemDateTime.TimeType.STARTUP, false)
    const timeout = this.retentionPolicy.backgroundTimeoutMs
    const pressure = this.retentionPressure
    this.retentionPressure = false
    let remaining = candidates.length
    const failed = new Set<number>()
    this.miniProgramOperationInProgress = true
    try {
      for (const index of candidates) {
        const since = this.retainedSince.get(index)
        const app = this.appPools.get(index)
        if (since === undefined || !app?.navigatorManager.isRetainedInBackground) continue
        if (pressure || remaining > this.retentionPolicy.maxBackgroundApps ||
          (timeout > 0 && now - since >= timeout)) {
          try {
            await app.closeDimina()
            this.retainedSince.delete(index)
            remaining--
          } catch (error) {
            // Keep the lease for a later host/config/pressure retry, and keep reclaiming
            // other apps. Do not spin an immediate timer against a failed expired lease.
            failed.add(index)
            DMPLogger.e(Tags.LAUNCH, `retention close failed: ${(error as Error).message}`)
          }
        }
      }
    } finally {
      this.miniProgramOperationInProgress = false
    }
    if (revision !== this.retentionRevision) {
      this.scheduleRetention()
      return
    }
    const next = candidates.find((index: number): boolean => this.retainedSince.has(index) && !failed.has(index))
    if (next !== undefined && timeout > 0) {
      this.retentionTimer = setTimeout((): void => this.scheduleRetention(),
        Math.min(2147483647, Math.max(1, this.retainedSince.get(next)! + timeout - now)))
    }
  }


  public static sharedInstance(): DMPAppManager {
    if (!DMPAppManager.instance) {
      DMPAppManager.instance = new DMPAppManager()
    }
    return DMPAppManager.instance
  }


  getApp(appIndex: number): DMPApp | undefined {
    return this.appPools.get(appIndex);
  }

  getPresentedApp(): DMPApp | undefined {
    const top = this.miniProgramPresentations.top()
    return top ? this.appPools.get(top.appIndex) : undefined
  }

  newAppWithConfig(appConfig: DMPAppConfig): DMPApp {
    this.appIndex++;
    let newApp = new DMPApp(appConfig, this.appIndex)
    DMPAppManager.sharedInstance().appPools.set(this.appIndex, newApp)
    this.miniProgramPresentations.ensureRoot(newApp.appIndex, newApp.appConfig.appId)
    return newApp
  }

  appWithConfig(appConfig: DMPAppConfig): DMPApp {
    DMPLogger.d(Tags.LAUNCH, "appWithConfig config=" + JSON.stringify(appConfig))
    let exitApp: DMPApp | null = this.existApp(appConfig.appId)
    if (exitApp != null) {
      DMPLogger.i(Tags.LAUNCH, "appWithConfig return exist DMPApp")
      this.miniProgramPresentations.ensureRoot(exitApp.appIndex, exitApp.appConfig.appId)
      return exitApp
    }
    DMPLogger.i(Tags.LAUNCH, "appWithConfig create DMPApp")
    this.appIndex++;
    let newApp = new DMPApp(appConfig, this.appIndex)
    DMPAppManager.sharedInstance().appPools.set(this.appIndex, newApp)
    this.miniProgramPresentations.ensureRoot(newApp.appIndex, newApp.appConfig.appId)
    return newApp
  }

  /**
   * Re-register a retained DMPApp shell after closeDimina removed its destroyed runtime.
   * Reusing the original appIndex is safe because indices are monotonic and cold re-entry already
   * rebuilds every app-indexed runtime resource. Never replace a different active instance.
   */
  restoreExitedApp(app: DMPApp): void {
    const appAtIndex = this.appPools.get(app.appIndex)
    if (appAtIndex === app) {
      return
    }
    if (appAtIndex) {
      throw new Error(`restoreExitedApp: appIndex ${app.appIndex} is already active`)
    }

    const appWithSameId = this.existApp(app.appConfig.appId)
    if (appWithSameId) {
      throw new Error(`restoreExitedApp: appId ${app.appConfig.appId} is already active`)
    }
    if (!this.miniProgramPresentations.ensureRoot(app.appIndex, app.appConfig.appId)) {
      throw new Error('restoreExitedApp: another mini program is currently presented')
    }
    this.appPools.set(app.appIndex, app)
  }

  existApp(appId: string): DMPApp | null {
    let result: DMPApp | null = null
    this.appPools.forEach((app) => {
      if (app.appConfig.appId === appId) {
        result = app
      }
    })
    return result
  }

  exitApp(appId: string, expectedAppIndex?: number) {
    let index: number | null = null
    if (expectedAppIndex !== undefined) {
      const expectedApp = this.appPools.get(expectedAppIndex)
      if (expectedApp?.appConfig.appId === appId) {
        index = expectedAppIndex
      }
    } else {
      this.appPools.forEach((app, key) => {
        if (app.appConfig.appId === appId) {
          index = key;
        }
      })
    }
    if (index !== null) {
      this.retainedSince.delete(index)
      this.appPools.delete(index)
      this.miniProgramPresentations.removeApp(index)
    }
  }

  // Required before querying/installing packages without launching a mini program.
  initialize(context: common.UIAbilityContext): void {
    DMPContextUtils.init(context)
  }

  // Configure before launching. A hidden capsule requires a host-provided exit action.
  public showCapsule: boolean = true

  // Capsule fill color, including alpha. Configure before launching mini programs.
  public capsuleBackgroundColor: ResourceColor = Color.White

  public showLaunchLoading: boolean = true

  isExistsApp(appId: string): boolean {
    return this.getAppVersionInfo(appId) !== undefined
  }

  getAppVersionInfo(appId: string): DMPMiniProgramVersionInfo | undefined {
    return DMPRemoteUpdateManager.sharedInstance().getAppVersionInfo(appId.trim())
  }

  async installMiniProgram(appId: string, packagePath: string): Promise<DMPMiniProgramVersionInfo> {
    const normalizedAppId = appId.trim()
    if (this.miniProgramOperationInProgress) {
      throw new Error('another mini program operation is in progress')
    }
    const manager = DMPRemoteUpdateManager.sharedInstance()
    manager.beginUninstall(normalizedAppId)
    this.miniProgramOperationInProgress = true
    try {
      const app = this.existApp(normalizedAppId)
      const openerIndex = app === null ? undefined : this.miniProgramPresentations.openerAppIndex(app.appIndex)
      const opener = openerIndex === undefined ? undefined : this.appPools.get(openerIndex)
      if (app !== null) {
        await app.closeDimina()
        if (opener) {
          opener.notifyMiniProgramShow(DMPScene.fromMiniProgramBack, new DMPMap({ appId: normalizedAppId }))
        }
      }
      return await manager.installLocalPackage(normalizedAppId, packagePath)
    } finally {
      this.miniProgramOperationInProgress = false
      manager.endUninstall(normalizedAppId)
    }
  }

  /**
   * Stop a running mini program and remove its installed package. Persistent
   * Storage/FileSystem data is retained unless clearUserData is true.
   */
  async uninstallMiniProgram(appId: string, clearUserData: boolean = false): Promise<void> {
    const normalizedAppId = appId.trim()
    if (this.miniProgramOperationInProgress) {
      throw new Error('uninstallMiniProgram:fail another mini program operation is in progress')
    }

    const updateManager = DMPRemoteUpdateManager.sharedInstance()
    updateManager.beginUninstall(normalizedAppId)
    this.miniProgramOperationInProgress = true
    try {
      const app = this.existApp(normalizedAppId)
      const openerIndex = app === null
        ? undefined
        : this.miniProgramPresentations.openerAppIndex(app.appIndex)
      const opener = openerIndex === undefined ? undefined : this.appPools.get(openerIndex)
      if (app !== null) {
        await app.closeDimina()
        if (opener) {
          opener.notifyMiniProgramShow(DMPScene.fromMiniProgramBack, new DMPMap({
            appId: normalizedAppId
          }))
        }
      }

      if (clearUserData) {
        DMPMMKVManager.clearStorage(normalizedAppId)
      }
      await DMPPreference.getInstance().remove(`${normalizedAppId}_versionName`)
      await DMPPreference.getInstance().remove(`${normalizedAppId}_versionCode`)
      await updateManager.uninstallPackage(normalizedAppId, clearUserData)
    } finally {
      this.miniProgramOperationInProgress = false
      updateManager.endUninstall(normalizedAppId)
    }
  }

  async navigateToMiniProgram(sourceApp: DMPApp, targetAppId: string, path: string | undefined,
    extraData: DMPMap): Promise<void> {
    const apiName = 'navigateToMiniProgram'
    this.beginMiniProgramOperation(sourceApp, apiName)
    let targetApp: DMPApp | undefined
    let sourceHidden = false
    const sourceLaunchConfig = sourceApp.getLaunchConfig()
    try {
      if (targetAppId === sourceApp.appConfig.appId) {
        throw new Error(`${apiName}:fail can not navigate to the current mini program`)
      }
      if (this.existApp(targetAppId) !== null) {
        throw new Error(`${apiName}:fail target mini program is already running`)
      }
      const resolvedConfig = this.resolveRawMiniProgramConfig(targetAppId)
      const targetPath = DMPMiniProgramPathParser.parse(path && path.length > 0 ? path : resolvedConfig.entryPath)
      if (targetPath.pagePath.length === 0) {
        throw new Error(`${apiName}:fail invalid path`)
      }

      // A presentation frame owns one DMPApp instance. Reusing or duplicating an app would both
      // interleave page records and collide in native managers that are keyed by appId.
      targetApp = this.newAppWithConfig(resolvedConfig.appConfig)
      if (!this.miniProgramPresentations.push(sourceApp.appIndex, targetApp.appIndex, targetAppId)) {
        throw new Error(`${apiName}:fail caller is not the presented mini program`)
      }

      sourceApp.notifyMiniProgramHide()
      sourceHidden = true

      const launchConfig = new DMPLaunchConfig()
      launchConfig.openType = DMPOpenType.NavigateTo
      launchConfig.appEntryPath = targetPath.pagePath
      launchConfig.query = targetPath.query
      launchConfig.scene = DMPScene.fromMiniProgram
      launchConfig.referrerInfo = new DMPMap({
        appId: sourceApp.appConfig.appId,
        extraData
      })

      const routeAccepted = new Promise<void>((resolve, reject) => {
        launchConfig.completion = (success: boolean) => {
          if (success) {
            resolve()
          } else {
            reject(new Error(`${apiName}:fail target mini program launch failed`))
          }
        }
      })
      await targetApp.startDimina(DMPContextUtils.getUIAbilityContext(), launchConfig)
      await routeAccepted
    } catch (error) {
      if (targetApp) {
        await targetApp.closeDimina()
      }
      if (sourceHidden) {
        this.resumeOpener(sourceApp, sourceLaunchConfig?.scene ?? DMPScene.fromMainEntry,
          sourceLaunchConfig?.referrerInfo)
      }
      throw error as Error
    } finally {
      this.endMiniProgramOperation()
    }
  }

  async navigateBackMiniProgram(currentApp: DMPApp, extraData: DMPMap,
    beforeClose: DMPMiniProgramBeforeDestructiveAction): Promise<void> {
    const apiName = 'navigateBackMiniProgram'
    this.beginMiniProgramOperation(currentApp, apiName)
    try {
      const opener = this.resolveOpener(currentApp, apiName)
      const referrerInfo = new DMPMap({
        appId: currentApp.appConfig.appId,
        extraData
      })
      await currentApp.closeDimina(beforeClose)
      this.resumeOpener(opener, DMPScene.fromMiniProgramBack, referrerInfo)
    } finally {
      this.endMiniProgramOperation()
    }
  }

  async hideMiniProgram(app: DMPApp): Promise<void> {
    if (app.navigatorManager.isRetainedInBackground) return
    this.beginMiniProgramOperation(app, 'hideMiniProgram')
    try {
      if (app.container.isNavigating) throw new Error('hideMiniProgram: navigation in progress')
      const openerIndex = this.miniProgramPresentations.openerAppIndex(app.appIndex)
      const opener = openerIndex === undefined ? undefined : this.appPools.get(openerIndex)
      app.navigatorManager.hidePresentation((): void => app.notifyMiniProgramHide())
      this.miniProgramPresentations.removeApp(app.appIndex)
      if (opener) this.resumeOpener(opener, DMPScene.fromMiniProgramBack,
        new DMPMap({ appId: app.appConfig.appId }))
    } finally {
      this.endMiniProgramOperation()
    }
  }

  resumeRetainedApp(app: DMPApp, config: DMPLaunchConfig): void {
    if (!this.miniProgramPresentations.ensureRoot(app.appIndex, app.appConfig.appId)) {
      throw new Error('resumeMiniProgram: another mini program is presented')
    }
    // The next windowStage SHOWN also reads this config; do not restore an old opener/scene.
    app.prepareHostEntry(config)
    const retainedConfig = app.getLaunchConfig()
    if (retainedConfig) {
      retainedConfig.scene = config.scene ?? DMPScene.fromMainEntry
      retainedConfig.referrerInfo = config.referrerInfo
    }
    app.navigatorManager.resumePresentation()
    this.resumeOpener(app, config.scene ?? DMPScene.fromMainEntry, config.referrerInfo, true)
    const completion = config.completion
    config.completion = undefined
    completion?.(true)
  }

  async exitMiniProgram(currentApp: DMPApp,
    beforeClose: DMPMiniProgramBeforeDestructiveAction): Promise<void> {
    const apiName = 'exitMiniProgram'
    if (currentApp.navigatorManager.isRetainedInBackground) {
      await currentApp.closeDimina(beforeClose)
      return
    }
    this.beginMiniProgramOperation(currentApp, apiName)
    try {
      const openerIndex = this.miniProgramPresentations.openerAppIndex(currentApp.appIndex)
      const opener = openerIndex === undefined ? undefined : this.appPools.get(openerIndex)
      await currentApp.closeDimina(beforeClose)
      if (opener) {
        this.resumeOpener(opener, DMPScene.fromMiniProgramBack, new DMPMap({
          appId: currentApp.appConfig.appId
        }))
      }
    } finally {
      this.endMiniProgramOperation()
    }
  }

  async restartMiniProgram(currentApp: DMPApp, path: string,
    beforeRestart: DMPMiniProgramBeforeDestructiveAction): Promise<void> {
    const apiName = 'restartMiniProgram'
    this.beginMiniProgramOperation(currentApp, apiName)
    try {
      const targetPath = DMPMiniProgramPathParser.parse(path)
      if (targetPath.pagePath.length === 0) {
        throw new Error(`${apiName}:fail invalid path`)
      }
      await beforeRestart()

      const currentLaunchConfig = currentApp.getLaunchConfig()
      const launchConfig = new DMPLaunchConfig()
      launchConfig.appEntryPath = targetPath.pagePath
      launchConfig.query = targetPath.query
      launchConfig.scene = currentLaunchConfig?.scene ?? DMPScene.fromMainEntry
      launchConfig.referrerInfo = currentLaunchConfig?.referrerInfo
      const routeAccepted = new Promise<void>((resolve, reject) => {
        launchConfig.completion = (success: boolean) => {
          if (success) {
            resolve()
          } else {
            reject(new Error(`${apiName}:fail restart launch failed`))
          }
        }
      })
      await currentApp.reEnter(launchConfig)
      await routeAccepted
    } finally {
      this.endMiniProgramOperation()
    }
  }

  private beginMiniProgramOperation(caller: DMPApp, apiName: string): void {
    if (this.miniProgramOperationInProgress) {
      throw new Error(`${apiName}:fail another mini program operation is in progress`)
    }
    if (!this.miniProgramPresentations.ensureRoot(caller.appIndex, caller.appConfig.appId)) {
      throw new Error(`${apiName}:fail caller is not the presented mini program`)
    }
    this.miniProgramOperationInProgress = true
  }

  private endMiniProgramOperation(): void {
    this.miniProgramOperationInProgress = false
    this.scheduleRetention()
  }

  /** 宿主前后台状态的唯一入口，由 DMPAppLifecycle 在 windowStage SHOWN/HIDDEN 时更新。 */
  setHostVisible(visible: boolean): void {
    this.hostVisible = visible
  }

  isHostVisible(): boolean {
    return this.hostVisible
  }

  /**
   * 把展示关系交还给 opener。
   *
   * 宿主在前台时这就是一次真实的 App.onShow；宿主已经进后台时（目标启动失败，或返回/退出
   * 在后台完成）只暂存 enter options：此刻派发会让账本以为 opener 已经显示，宿主真正回到
   * 前台时那条 show 就被去重掉，小程序再也收不到本次返回的 onShow。
   */
  private resumeOpener(opener: DMPApp, scene: DMPScene, referrerInfo?: DMPMap, hostEntry: boolean = false): void {
    if (!hostEntry && scene === DMPScene.fromMiniProgramBack) opener.clearHostEntryOptions()
    if (this.hostVisible) {
      opener.notifyMiniProgramShow(scene, referrerInfo)
    } else {
      opener.stashMiniProgramShow(scene, referrerInfo)
    }
  }

  private resolveOpener(currentApp: DMPApp, apiName: string): DMPApp {
    const openerIndex = this.miniProgramPresentations.openerAppIndex(currentApp.appIndex)
    if (openerIndex === undefined) {
      throw new Error(`${apiName}:fail no opener mini program`)
    }
    const opener = this.appPools.get(openerIndex)
    if (!opener) {
      throw new Error(`${apiName}:fail opener mini program is unavailable`)
    }
    return opener
  }

  private resolveRawMiniProgramConfig(appId: string): DMPResolvedMiniProgramConfig {
    const rawConfig = DMPRawFileUtils.loadFile(DMPContextUtils.getUIAbilityContext(),
      `jsapp/${appId}/config.json`)
    if (rawConfig.length === 0) {
      throw new Error(`navigateToMiniProgram:fail target mini program ${appId} is not bundled`)
    }

    let configMap: DMPMap
    try {
      configMap = DMPMap.createFromString(rawConfig)
    } catch (_) {
      throw new Error(`navigateToMiniProgram:fail invalid target config for ${appId}`)
    }
    const configuredAppId: string = configMap.getString('appId') ?? ''
    const appName: string = configMap.getString('name') ?? ''
    const entryPath: string = configMap.getString('path') ?? ''
    if (configuredAppId !== appId || appName.length === 0) {
      throw new Error(`navigateToMiniProgram:fail invalid target config for ${appId}`)
    }
    return new DMPResolvedMiniProgramConfig(new DMPAppConfig(appName, appId), entryPath)
  }
}
