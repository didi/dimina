
import { DMPAppConfig } from './config/DMPAppConfig'
import { DMPApp } from './DMPApp'
import { DMPLogger } from '../EventTrack/DMPLogger'
import { Tags } from '../EventTrack/Tags'
import { DMPDeviceUtil } from '../Utils/DMPDeviceUtils'
import { DMPContextUtils } from '../Utils/DMPContextUtils'
import { DMPRawFileUtils } from '../Utils/DMPRawFileUtils'
import { DMPMap } from '../Utils/DMPMap'
import { DMPLaunchConfig, DMPOpenType, DMPScene } from './config/DMPLaunchConfig'
import {
  DMPMiniProgramPathParser,
  DMPMiniProgramPresentationStack
} from './DMPMiniProgramPresentationStack'
import { DMPRemoteUpdateManager } from '../Bundle/DMPRemoteUpdateManager'
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

/**
 * 谁拥有共享窗口。
 * appPools 里可以同时驻留多个小程序实例（切回小程序列表再打开另一个，旧的并未退出），但窗口只有一个，几何上报与方向请求都只能出自它。
 * 归属跟随唯一的事实——屏幕上还有没有这个 app 的页面：DMPPage 的 onShown/onHidden （ArkUI Navigation 的可见性回调，「被 push 盖住」「盖住别人的 pop 后重新露出」都会触发）按页面身份更新可见集。
 * 同一个 app 内部换页时新页 onShown 与旧页 onHidden 的先后没有保证；同一页面的重复回调也不能重复记账。页面集合同时覆盖这两个边界，并在最后一页隐去时如实交还窗口。
 * 归属只有两种交出方式：另一个 app 的页面露面接管，或自己的可见页归零/退出。
 */
export class DMPForegroundAppLedger {
  private foregroundAppIndex: number = -1
  private visiblePages: Map<number, Set<number>> = new Map()

  pageShown(appIndex: number, webViewId: number): void {
    let pages: Set<number> | undefined = this.visiblePages.get(appIndex)
    if (!pages) {
      pages = new Set<number>()
      this.visiblePages.set(appIndex, pages)
    }
    pages.add(webViewId)
    this.foregroundAppIndex = appIndex
  }

  /**
   * 还没有任何 app 拥有共享窗口时认领它；已经有主就什么都不做——归属只能由可见页集合交出，这里不参与抢占。
   * 存在的理由是一段真实的空窗：导航是先把页面压进 NavPathStack、紧接着同步调 DMPPageLifecycle.onShow（DMPNavigator.openPage），而 ArkUI 的 onShown 要到下一帧才回调。
   * 冷启动第一页就在这段空窗里发出方向请求并把 pageShow 押给窗口几何回调，此刻账本还是空的，那次回调会被归属判据整个丢掉，pageShow 再没有第二次放行机会。
   * 只补「无主时认领」这一种情形：可见页集合仍然只由 onShown/onHidden 维护，交还窗口的路径不变，也不会从屏幕上真实可见的另一个 app 手里抢走归属。
   */
  claimIfUnowned(appIndex: number): void {
    if (this.foregroundAppIndex < 0) {
      this.foregroundAppIndex = appIndex
    }
  }

  pageHidden(appIndex: number, webViewId: number): void {
    const pages: Set<number> | undefined = this.visiblePages.get(appIndex)
    if (!pages) {
      return
    }
    pages.delete(webViewId)
    if (pages.size > 0) {
      return
    }
    this.visiblePages.delete(appIndex)
    this.clearIfOwned(appIndex)
  }

  /** 小程序退出：可见页账本和归属一起抹掉，不等它逐页发 onHidden。 */
  release(appIndex: number): void {
    this.visiblePages.delete(appIndex)
    this.clearIfOwned(appIndex)
  }

  clearIfOwned(appIndex: number): void {
    if (this.foregroundAppIndex === appIndex) {
      this.foregroundAppIndex = -1
    }
  }

  isForeground(appIndex: number): boolean {
    return this.foregroundAppIndex === appIndex
  }

  currentIndex(): number {
    return this.foregroundAppIndex
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
  private foregroundLedger: DMPForegroundAppLedger = new DMPForegroundAppLedger()

  public static sharedInstance(): DMPAppManager {
    if (!DMPAppManager.instance) {
      DMPAppManager.instance = new DMPAppManager()
    }
    return DMPAppManager.instance
  }

  notifyPageShown(appIndex: number, webViewId: number): void {
    this.foregroundLedger.pageShown(appIndex, webViewId)
    this.syncWindowOrientationToOwner()
  }

  notifyPageHidden(appIndex: number, webViewId: number): void {
    this.foregroundLedger.pageHidden(appIndex, webViewId)
    this.syncWindowOrientationToOwner()
  }

  claimWindowIfUnowned(appIndex: number): void {
    this.foregroundLedger.claimIfUnowned(appIndex)
  }

  /**
   * 窗口方向跟着窗口归属走。
   * 归属换人或落空是唯一能改变「谁有权决定窗口方向」的事实，所以两者必须在同一个点上结算，否则会出现：小程序还驻留在 appPools 里、它的页面已经被宿主页面盖住，窗口却仍停在小程序设定的方向上——宿主自己的界面跟着一起横过来，直到那个小程序真正退出（exitApp 里的 restoreHostOrientation）才恢复。
   *
   * 这里做成「按当前归属重算一次」而不是「按转移方向各做各的」：同一个 app 内部换页时新页 onShown 与旧页 onHidden 的先后没有保证，归属可能瞬时落空又立刻被接回来。
   * 重算是幂等的，两种顺序最终都收敛到同一个结果；中途那次恢复请求会被随后的方向请求按 generation 作废（见 DMPDeviceUtil.restoreHostOrientation），不会覆盖新归属者的方向。
   */
  private syncWindowOrientationToOwner(): void {
    const owner: DMPApp | undefined = this.getForegroundApp()
    if (owner) {
      owner.applyCurrentPageOrientation()
      return
    }
    DMPDeviceUtil.restoreHostOrientation().catch((err: Error) => {
      DMPLogger.e(Tags.LAUNCH, `restoreHostOrientation failed: ${err.message}`)
    })
  }

  isForegroundApp(appIndex: number): boolean {
    return this.foregroundLedger.isForeground(appIndex)
  }

  getForegroundApp(): DMPApp | undefined {
    const index: number = this.foregroundLedger.currentIndex()
    return index >= 0 ? this.appPools.get(index) : undefined
  }


  getApp(appIndex: number): DMPApp | undefined {
    return this.appPools.get(appIndex);
  }

  getPresentedApp(): DMPApp | undefined {
    const top = this.miniProgramPresentations.top()
    return top ? this.appPools.get(top.appIndex) : undefined
  }

  canDispatchPageShow(appIndex: number): boolean {
    return this.miniProgramPresentations.canDispatchPageShow(appIndex, this.hostVisible)
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
      this.appPools.delete(index)
      this.miniProgramPresentations.removeApp(index)
      this.foregroundLedger.release(index)
      // 所有 dispose 路径最终都走这里删 appPools，是唯一能判断「是不是最后一个」的地方：appPools 空了说明窗口要还给宿主，得把小程序改过的方向恢复掉，否则宿主会带着上一个小程序设定的方向继续跑。
      if (this.appPools.size === 0) {
        DMPDeviceUtil.restoreHostOrientation().catch((err: Error) => {
          DMPLogger.e(Tags.LAUNCH, `restoreHostOrientation failed: ${err.message}`)
        })
      }
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

  async exitMiniProgram(currentApp: DMPApp,
    beforeClose: DMPMiniProgramBeforeDestructiveAction): Promise<void> {
    const apiName = 'exitMiniProgram'
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
  }

  /** 宿主前后台状态的唯一入口，由 DMPAppLifecycle 在 windowStage SHOWN/HIDDEN 时更新。 */
  setHostVisible(visible: boolean): void {
    this.hostVisible = visible
  }

  /**
   * 把展示关系交还给 opener。
   *
   * 宿主在前台时这就是一次真实的 App.onShow；宿主已经进后台时（目标启动失败，或返回/退出
   * 在后台完成）只暂存 enter options：此刻派发会让账本以为 opener 已经显示，宿主真正回到
   * 前台时那条 show 就被去重掉，小程序再也收不到本次返回的 onShow。
   */
  private resumeOpener(opener: DMPApp, scene: DMPScene, referrerInfo?: DMPMap): void {
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
