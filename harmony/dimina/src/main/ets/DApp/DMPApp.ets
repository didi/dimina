import { DMPAppConfig, DMPLaunchType } from './config/DMPAppConfig'
import { DMPCustomConfig, DMPLaunchConfig, DMPOpenType, DMPScene } from './config/DMPLaunchConfig'
import { DMPFileManager } from '../Bundle/Util/DMPFileManager'
import { DMPService } from '../Service/DMPService'
import { DMPRender } from '../Render/DMPRender'
import { DMPBridges } from '../Bridges/DMPBridges'
import { DMPBundleManager } from '../Bundle/DMPBundleManager'
import { DMPBundleInstallConfig } from '../Bundle/Model/DMPBundleInstallConfig'
import { DMPContextUtils } from '../Utils/DMPContextUtils'
import { DMPBundleLoadInfo } from '../Bundle/Model/DMPBundleLoadInfo'
import { DMPContainer } from '../Container/DMPContainer'
import { DMPLogger } from '../EventTrack/DMPLogger'
import { Tags } from '../EventTrack/Tags'
import window from '@ohos.window'
import { ImageKnife } from '@ohos/imageknifepro'
import { DMPWebViewController } from '../HybridContainer/DMPWebViewController'
import { DMPAppModuleManager } from '../Bridges/DMPAppModuleManager'
import { DMPExtModuleHandler } from '../Bridges/DMPExtModuleHandler'
import { DMPWindowUtil } from '../Utils/DMPWindowUtils'
import { DMPEntryContext } from './config/DMPEntryContext'
import { DMPChannelProxyNext } from '../Service/DMPChannelProxyNext'
import { DMPMap } from '../Utils/DMPMap'
import { DMPMapManager } from '../Bridges/Map/DMPMapBridgeManager'
import { DMPWebViewCachePool } from '../HybridContainer/DMPWebViewCachePool'
import { EngineStatus, StatusMonitor } from './utils/DMPStatusMonitor'
import { common } from '@kit.AbilityKit'
import { DMPNavigatorDelegate } from '../Navigator/DMPNavigatorDelegate'
import { DMPAppManager } from './DMPAppManager'
import { DMPNavigatorManager } from '../Navigator/DMPNavigatorManager'
import { DMPPageStateTeardown } from '../Navigator/DMPPageStateTeardown'
import { DRouter } from '../Navigator/DRouter'
import { DMPAppLifecycle } from './DMPAppLifecycle'
import { DMPDeviceUtil } from '../Utils/DMPDeviceUtils'
import { DMPRemoteUpdateManager } from '../Bundle/DMPRemoteUpdateManager'
import { DMPWebSocketManager } from '../Bridges/Network/DMPWebSocketManager'
import { DMPAppModuleManagerLifecycle } from '../Bridges/DMPAppModuleManagerLifecycle'
import { DMPAppRuntimeLifecycle } from './utils/DMPAppRuntimeLifecycle'
import { DMPAppVisibilityLedger } from './utils/DMPAppVisibilityLedger'
import { CanvasExportJobRegistry } from '../Bridges/CanvasExportJobRegistry'
export type DMPBundleUpdateCallback = () => void;

export interface DMPAppInitOptions {
  apiNamespaces?: string[];
}

//小程序应用实例
export class DMPApp {
  appIndex: number;
  appConfig: DMPAppConfig
  customConfig: DMPCustomConfig = new DMPCustomConfig();
  private onUpdateResults: DMPBundleUpdateCallback[] = []
  private _container: DMPContainer = new DMPContainer(this)
  private static _context: common.UIAbilityContext
  private static _apiNamespaces: string[] = []
  private _containerBridges: DMPBridges = new DMPBridges()
  private static _entryContext: DMPEntryContext
  private _appModuleManagerLifecycle: DMPAppModuleManagerLifecycle
  private _mapManager: DMPMapManager = new DMPMapManager(this)
  private _runtimeGeneration: number = 0
  private _runtimeLifecycle: DMPAppRuntimeLifecycle = new DMPAppRuntimeLifecycle()
  private _visibilityLedger: DMPAppVisibilityLedger = new DMPAppVisibilityLedger()
  // 宿主后台期间攒下的那一次恢复要带的 enter options，见 [stashMiniProgramShow]。
  private _pendingShowScene: DMPScene | undefined = undefined
  private _pendingShowReferrer: DMPMap | undefined = undefined
  private _closeInProgress?: Promise<void>
  private _deferredLaunchConfigs: DMPLaunchConfig[] = []
  private _webViewCachePool: DMPWebViewCachePool = new DMPWebViewCachePool(this)
  private _service: DMPService
  private _engineStatus: StatusMonitor<EngineStatus> = new StatusMonitor()
  private _render: DMPRender = new DMPRender(this)
  router: DRouter = DRouter.getInstance();

  private static readonly deviceMetricsChangeCallback = (_metrics: DMPMap): void => {
    DMPAppManager.sharedInstance().appPools.forEach((app: DMPApp) => {
      app.container.updateHostEnv()
    })
  }

  public get render(): DMPRender {
    return this._render
  }

  constructor(appConfig: DMPAppConfig, appIndex: number) {
    this.appIndex = appIndex;
    this.appConfig = appConfig
    CanvasExportJobRegistry.activate(this.appConfig.appId, this.canvasExportOwner)
    this._appModuleManagerLifecycle = new DMPAppModuleManagerLifecycle(
      new DMPAppModuleManager(this),
      (): DMPAppModuleManager => new DMPAppModuleManager(this)
    )
    this._service = new DMPService(this.appIndex)
    this._bundleManager = new DMPBundleManager(this);
  }

  public get container(): DMPContainer {
    return this._container
  }

  public static get context(): common.UIAbilityContext {
    return DMPApp._context
  }

  public get containerBridges(): DMPBridges {
    return this._containerBridges
  }

  public static get entryContext(): DMPEntryContext {
    return DMPApp._entryContext
  }

  public get appModuleManager(): DMPAppModuleManager {
    return this._appModuleManagerLifecycle.manager as DMPAppModuleManager
  }

  private _bundleManager: DMPBundleManager

  public get bundleManager(): DMPBundleManager {
    return this._bundleManager
  }

  public get service(): DMPService {
    return this._service
  }

  public get mapManager(): DMPMapManager {
    return this._mapManager
  }

  private _navigatorManager: DMPNavigatorManager = new DMPNavigatorManager(this);

  public get webViewCachePool(): DMPWebViewCachePool {
    return this._webViewCachePool
  }

  public get navigatorManager(): DMPNavigatorManager {
    return this._navigatorManager
  }

  public get engineStatus(): StatusMonitor<EngineStatus> {
    return this._engineStatus
  }

  public get runtimeGeneration(): number {
    return this._runtimeGeneration
  }

  public get canvasExportOwner(): string {
    return `${this.appIndex}:${this._runtimeGeneration}`
  }

  private _bottomSafeHeight = -1

  public get bottomSafeHeight() {
    return this._bottomSafeHeight
  }

  public get currentWebViewId(): number {
    // 走 getActivePageRecord：tab 模式下返回真实选中 tab，
    // 否则返回栈顶（含 navigateTo 推入的页面 / 非 tab 场景）
    return this.navigatorManager!.getActivePageRecord()?.webViewId ?? -1
  }

  public static getWindowStage(): window.WindowStage {
    return DMPApp._entryContext.getWindowStage();
  }

  static init(context: DMPEntryContext, options?: DMPAppInitOptions) {
    DMPApp._entryContext = context;
    DMPApp._context = DMPApp._entryContext.getContext();
    DMPApp._apiNamespaces = options?.apiNamespaces ?? [];
    ImageKnife.getInstance()
      .initFileCache(DMPApp._entryContext.getContext())
      .catch((error: Error) => {
        DMPLogger.e(Tags.LAUNCH, `ImageKnifePro initFileCache failed: ${error.message}`)
      })
    context.getWindowStage().on('windowStageEvent', DMPAppLifecycle.onWindowStageEvent);
    try {
      DMPDeviceUtil.prepareSafeAreaAndDisplayWHForWindow(context.getWindowStage().getMainWindowSync())
    } catch (_) {
      DMPDeviceUtil.prepareSafeAreaAndDisplayWH(DMPApp._entryContext.getContext())
    }
    DMPDeviceUtil.addMetricsChangeListener(DMPApp.deviceMetricsChangeCallback)
  }

  getWebController(webViewId: number): DMPWebViewController {
    return this._render.getController(webViewId)
  }

  reLaunch(config?: DMPLaunchConfig) {
    const naviCount = this.navigatorManager.count();
    if (naviCount > 1) {
      this.reLaunchCurrentStack(config);
    } else {
      this.reLaunchRootStack(config);
    }
  }

  reLaunchCurrentStack(config?: DMPLaunchConfig) {
    const curNavigator = this.navigatorManager.getCurNavigator();
    const curLaunchConfig = curNavigator!.getLaunchConfig();
    let pageCount = curNavigator?.getPageCount() ?? 1;
    if (curLaunchConfig.customLaunchPageCallBack || curLaunchConfig.openType == DMPOpenType.Insert) {
      pageCount -= 1;
    }
    curNavigator?.navigateBack(pageCount, false, false, true);
    // navigateBack -> pop() 内部没有真正的 await，上面这一行已经同步跑完：当前 navigator
    // 清完栈后，pop() 里 `_stacks.size() < 1` 的分支会把它自己从 navigatorManager 摘除。
    // 此时账本里如果还剩 navigator，就是本次 reLaunch 从未触碰过的下层 navigator（问题
    // 场景：customLaunchPageCallBack/openType=Insert 让宿主在已有 navigator 上插入了第二
    // 层）——不清掉的话它们会在共享 NavPathStack 里永久残留。复用现有的批量关闭能力，不
    // 单独实现一套清栈逻辑
    if (!this.navigatorManager.isEmpty()) {
      this.navigatorManager.closeAllNavigators(DMPPageStateTeardown.Routing, false)
    }
    //为什么延时，因为鸿蒙pop和push 会相互抵消，导致页面不能正常关闭
    setTimeout(() => {
      if (config) {
        curLaunchConfig.appEntryPath = config.appEntryPath
        curLaunchConfig.query = config.query
      }
      this.launch(curLaunchConfig);
    }, 100);
  }

  reLaunchRootStack(config?: DMPLaunchConfig) {
    DMPLogger.i(Tags.LAUNCH, "resetStatusAndReLaunch");
    const curNavigator = this.navigatorManager.getCurNavigator();
    const curLaunchConfig = curNavigator!.getLaunchConfig();
    let pageCount = curNavigator?.getPageCount() ?? 1;
    if (curLaunchConfig.customLaunchPageCallBack || curLaunchConfig.openType == DMPOpenType.Insert) {
      pageCount -= 1;
    }
    curNavigator?.navigateBack(pageCount, false, false, true);

    const launchMain = async () => {
      DMPLogger.i(Tags.LAUNCH, "launchMain");
      await this.startMainService()
      if (config) {
        curLaunchConfig.appEntryPath = config.appEntryPath
        curLaunchConfig.query = config.query
      }
      this.launch(curLaunchConfig)
    };

    setTimeout(launchMain, 100);
  }

  async reEnter(config?: DMPLaunchConfig) {
    const currentLaunchConfig = this.navigatorManager.getCurNavigator()?.getLaunchConfig()
    const nextLaunchConfig = currentLaunchConfig ?? config ?? new DMPLaunchConfig()
    if (config) {
      nextLaunchConfig.appEntryPath = config.appEntryPath
      nextLaunchConfig.query = config.query
      nextLaunchConfig.scene = config.scene
      nextLaunchConfig.referrerInfo = config.referrerInfo
      nextLaunchConfig.firstDomReadyListener = config.firstDomReadyListener
      // Keep the current config object so host custom page mounting survives, but hand the new
      // runtime its own one-shot route completion used by restartMiniProgram.
      nextLaunchConfig.completion = config.completion
    }
    this.notifyRuntimeTeardownHide()
    // restart 是「关掉再重开」而不是一次路由：上面已经发过 App.onHide，旧运行时紧接着
    // 整体销毁，所以和退出同源，不补 onUnload。
    this.navigatorManager.closeAllNavigators(DMPPageStateTeardown.Exit, false)
    // Terminal API callbacks are queued to the Worker. Drain them before terminating the old
    // runtime; a fixed timeout cannot provide this ordering guarantee.
    await this._service.flush()
    this.destroyEngine()
    this.resetAndStartDimina(nextLaunchConfig)
  }

  resetAndStartDimina(config: DMPLaunchConfig) {
    this.rebuildRuntime()
    this.startDimina(DMPContextUtils.getUIAbilityContext(), config);
  }

  /**
   * @param afterExit 小程序已经退出过、这次是重新展示。restart 则是容器留在原地只换运行时，
   * 两者对「容器当前是否可见」的判断不同，见 DMPAppVisibilityLedger。
   */
  private rebuildRuntime(afterExit: boolean = false) {
    this.onUpdateResults = []
    this._runtimeGeneration++
    CanvasExportJobRegistry.activate(this.appConfig.appId, this.canvasExportOwner)
    // destroyEngine disposes app-scoped native listeners. A cold restart must use a fresh bridge
    // module graph; the lifecycle also replays host ext modules registered on this DMPApp.
    this._appModuleManagerLifecycle.rebuild()
    this._service = new DMPService(this.appIndex);
    this._render = new DMPRender(this);
    this._container = new DMPContainer(this);
    this._navigatorManager = new DMPNavigatorManager(this);
    this._mapManager = new DMPMapManager(this);
    this._webViewCachePool = new DMPWebViewCachePool(this);
    this._engineStatus = new StatusMonitor();
    this._runtimeLifecycle.markReady()
    if (afterExit) {
      this._visibilityLedger.markRuntimeRelaunched()
      // 重新启动的小程序带的是自己的启动场景，退出前攒下的那次返回场景已经过期。
      this._pendingShowScene = undefined
      this._pendingShowReferrer = undefined
    } else {
      this._visibilityLedger.markRuntimeReplaced()
    }
    const deferredLaunchConfigs = this._deferredLaunchConfigs.splice(0)
    deferredLaunchConfigs.forEach((launchConfig: DMPLaunchConfig): void => {
      this.launchWhenRuntimeReady(launchConfig)
    })
  }

  private restoreRuntimeIfDestroyed(): void {
    if (!this._runtimeLifecycle.isDestroyed) {
      return
    }

    const appManager = DMPAppManager.sharedInstance()
    appManager.restoreExitedApp(this)
    try {
      this.rebuildRuntime(true)
    } catch (error) {
      appManager.exitApp(this.appConfig.appId, this.appIndex)
      throw error as Error
    }
  }

  async updateApp(): Promise<boolean> {
    DMPLogger.i(Tags.LAUNCH, "updateApp invoke")
    const activated = await DMPRemoteUpdateManager.sharedInstance()
      .activatePendingUpdate(this.appConfig.appId)
    if (!activated) {
      this.notifyUpdateManagerStatus('updatefail')
      return false
    }
    const curLaunchConfig = this.navigatorManager.getCurNavigator()?.getLaunchConfig()
    await this.reEnter(curLaunchConfig)
    return true
  }


  async startDimina(context: common.UIAbilityContext, launchConfig: DMPLaunchConfig) {
    this.startPackageLoader(context, launchConfig).catch((error: Error) => {
      DMPLogger.e(Tags.LAUNCH, `startDimina failed: ${error.message}`)
      this._engineStatus.setStatus(EngineStatus.STOP)
      this.settleLaunchCompletion(launchConfig, false)
    })
    this.launch(launchConfig)
  }

  async startPackageLoader(context: common.UIAbilityContext, launchConfig?: DMPLaunchConfig) {
    DMPLogger.i(Tags.LAUNCH, 'startPackageLoader start')
    const closeInProgress = this._closeInProgress
    if (closeInProgress) {
      await closeInProgress
    }
    this.restoreRuntimeIfDestroyed()
    const generation = this._runtimeGeneration
    if (this._engineStatus.currentStatus != EngineStatus.RUN &&
      this._engineStatus.currentStatus != EngineStatus.LOADING) { // 已经启动jsEngine
      this._engineStatus.setStatus(EngineStatus.LOADING)
      DMPContextUtils.init(context)
      let fileManager: DMPFileManager = DMPFileManager.sharedInstance()
      fileManager.createLocalBundleDirectoryForApp(this.appConfig.appId)
      let installConfig =
        new DMPBundleInstallConfig(DMPContextUtils.getUIAbilityContext(), this.appConfig.appId, this.appIndex);
      installConfig.launchAppType = this.appConfig.launchAppType;

      const failLaunch = (code: number, errMsg: string): void => {
        if (generation !== this._runtimeGeneration) {
          return
        }
        DMPLogger.e(Tags.LAUNCH, `startPackageLoader failed code=${code} errMsg=${errMsg}`)
        this._engineStatus.setStatus(EngineStatus.STOP)
        this.settleLaunchCompletion(launchConfig, false)
      }

      let waitLaunchBundleReady = async (config: DMPBundleLoadInfo) => {
        try {
          if (generation !== this._runtimeGeneration) {
            return
          }
          DMPLogger.i(Tags.LAUNCH,
            "launchBundleReady: launchType: " + DMPLaunchType[installConfig.launchAppType]);
          await this._bundleManager.loadConfigFile()
          if (generation !== this._runtimeGeneration) {
            return
          }
          this._service.updateWorkerAppData();
          await this.startEngineService()
          if (generation !== this._runtimeGeneration) {
            return
          }
          await this.startMainService()
          if (generation !== this._runtimeGeneration) {
            return
          }
          this.startRemoteUpdateCheck()

          this._engineStatus.setStatus(EngineStatus.RUN)
        } catch (error) {
          failLaunch(-1, (error as Error).message)
        }
      };

      const loadComplete = (config: DMPBundleLoadInfo) => {

      }
      const loadError = (code: number, errMsg: string) => failLaunch(code, errMsg)
      //安装小程序包
      await this._bundleManager.install(installConfig, waitLaunchBundleReady, loadComplete, loadError)
    }
  }

  //启动页面
  launch(launchConfig: DMPLaunchConfig) {
    if (this._runtimeLifecycle.shouldDeferLaunch()) {
      this._deferredLaunchConfigs.push(launchConfig)
      return
    }
    try {
      this.restoreRuntimeIfDestroyed()
    } catch (error) {
      DMPLogger.e(Tags.LAUNCH, `launch failed: ${(error as Error).message}`)
      this.settleLaunchCompletion(launchConfig, false)
      return
    }
    this.launchWhenRuntimeReady(launchConfig)
  }

  private launchWhenRuntimeReady(launchConfig: DMPLaunchConfig) {
    if (this._engineStatus.currentStatus == EngineStatus.RUN) {
      this.launchInner(launchConfig)
    } else {
      const listener = (status: EngineStatus) => {
        if (status == EngineStatus.RUN) {
          this._engineStatus.removeStatusListener(listener)
          this.launchInner(launchConfig)
        }
      };
      this._engineStatus.addStatusListener(listener);
    }
  }

  private settleLaunchCompletion(launchConfig: DMPLaunchConfig | undefined, success: boolean): void {
    if (!launchConfig) {
      return
    }
    const completion = launchConfig.completion
    launchConfig.completion = undefined
    completion?.(success)
  }

  public closeDimina(afterPagesClosed?: () => Promise<void>): Promise<void> {
    if (this._runtimeLifecycle.isDestroyed) {
      this.destroyApp()
      return Promise.resolve()
    }
    if (!this._runtimeLifecycle.beginClose()) {
      return this._closeInProgress ?? Promise.resolve()
    }

    const closeOperation = this.performClose(afterPagesClosed)
    this._closeInProgress = closeOperation.then((): void => {
      this._closeInProgress = undefined
    }, (error: Error): void => {
      this._runtimeLifecycle.cancelClose()
      this._closeInProgress = undefined
      const deferredLaunchConfigs = this._deferredLaunchConfigs.splice(0)
      deferredLaunchConfigs.forEach((launchConfig: DMPLaunchConfig): void => {
        this.settleLaunchCompletion(launchConfig, false)
      })
      throw error
    })
    return this._closeInProgress
  }

  private async performClose(afterPagesClosed?: () => Promise<void>) {
    this.notifyMiniProgramHide()
    // 退出对齐微信的「小程序切入后台」：只派发 App.onHide，页面不收 onUnload。
    this.navigatorManager.closeAllNavigators(DMPPageStateTeardown.Exit, false)
    if (afterPagesClosed) {
      // The callback uses the old service runtime, so it must run after page unload is queued
      // but before destroyEngine terminates that Worker.
      await afterPagesClosed()
    }
    await this._service.flush()
    this.destroyEngine()
    this.destroyApp()
    DMPLogger.i(Tags.LAUNCH, 'Doing something in closeApp')
  }

  public hiApp() {
    DMPLogger.i(Tags.LAUNCH, 'Doing something in closeApp')
  }

  /** Hide only this mini program; unlike DMPAppLifecycle this never broadcasts to every pooled app. */
  public notifyMiniProgramHide() {
    if (!this._visibilityLedger.request(false)) {
      return
    }
    this.dispatchAppHide()
  }

  /**
   * 运行时整体销毁前把终态 App.onHide 交给旧 Worker。容器留在原地，所以这不是一次容器
   * 隐藏：销毁窗口期内到达的真实前后台变化仍记在账本上，由新运行时就绪时结算。
   */
  private notifyRuntimeTeardownHide() {
    if (!this._visibilityLedger.requestRuntimeTeardownHide()) {
      return
    }
    this.dispatchAppHide()
  }

  private dispatchAppHide() {
    const bridgeId = this.currentWebViewId
    if (bridgeId > 0) {
      this.navigatorManager.dispatchPageHide(bridgeId)
    }
    DMPChannelProxyNext.ContainerToService(new DMPMap({
      type: 'appHide',
      body: { bridgeId }
    }), this.appIndex)
  }

  /** Reveal only this mini program and update App.onShow/GetEnterOptionsSync data. */
  public notifyMiniProgramShow(scene: DMPScene, referrerInfo?: DMPMap) {
    if (!this._visibilityLedger.request(true)) {
      return
    }
    if (this._pendingShowScene !== undefined) {
      const pendingScene = this._pendingShowScene
      const pendingReferrer = this._pendingShowReferrer
      this._pendingShowScene = undefined
      this._pendingShowReferrer = undefined
      this.dispatchAppShow(pendingScene, pendingReferrer)
      return
    }
    this.dispatchAppShow(scene, referrerInfo)
  }

  /**
   * 宿主在后台时把这个小程序恢复成展示中的那一个。
   *
   * 这不是一次可见性变化——容器整体不可见，opener 也就没有显示——所以账本不动，只记下这次
   * 恢复该带的 scene/referrerInfo。真正的 App.onShow 由宿主回到前台时派发，届时这份
   * enter options 会覆盖调用方的默认值，把 1038 和 referrerInfo 带到正确的那条 show 上。
   */
  public stashMiniProgramShow(scene: DMPScene, referrerInfo?: DMPMap) {
    this._pendingShowScene = scene
    this._pendingShowReferrer = referrerInfo
  }

  private dispatchAppShow(scene: DMPScene, referrerInfo?: DMPMap) {
    const record = this.navigatorManager.getActivePageRecord()
    const bridgeId = record?.webViewId ?? -1
    const body = new DMPMap({
      bridgeId,
      scene,
      path: record?.pagePath ?? '',
      pagePath: record?.pagePath ?? '',
      query: record?.params?.get('query') ?? new DMPMap()
    })
    if (referrerInfo) {
      body.set('referrerInfo', referrerInfo)
    }
    DMPChannelProxyNext.ContainerToService(new DMPMap({
      type: 'appShow',
      body
    }), this.appIndex)
    if (bridgeId > 0) {
      this.navigatorManager.dispatchPageShow(bridgeId)
    }
  }

  public showStack(stackId: number) {
    const msg: DMPMap = new DMPMap({
      type: 'stackShow',
      body: {
        stackId
      }
    })
    DMPChannelProxyNext.ContainerToService(msg, this.appIndex)
  }

  public hideStack(stackId: number) {
    const msg: DMPMap = new DMPMap({
      type: 'stackHide',
      body: {
        stackId
      }
    })
    DMPChannelProxyNext.ContainerToService(msg, this.appIndex)
  }

  /**
   * 注册宿主第三方扩展模块，使小程序可通过 wx.extBridge / wx.extOnBridge / wx.extOffBridge 调用。
   *
   * @param moduleName  宿主模块名，须与 JS 侧传入的 module 参数一致
   * @param handler     模块处理函数，参见 DMPExtModuleHandler
   */
  registerExtModule(moduleName: string, handler: DMPExtModuleHandler): void {
    this._appModuleManagerLifecycle.registerExtModule(moduleName, handler);
  }

  destroyEngine() {
    if (this._runtimeLifecycle.isDestroyed) {
      return
    }
    // Invalidate bundle/bootstrap callbacks and delayed cache work before disposing their owners.
    this._runtimeGeneration++
    CanvasExportJobRegistry.activate(this.appConfig.appId, this.canvasExportOwner)
    this._runtimeLifecycle.markDestroyed()
    // 销毁前取消所有 extOnBridge 订阅，防止内存泄漏
    this._appModuleManagerLifecycle.disposeCurrent();
    // 先于 service 销毁：静默清理该 appId 全部 WebSocket 连接/监听/定时器，杜绝事件竞入将死引擎
    DMPWebSocketManager.sharedInstance().disposeOwner(this.appConfig.appId);
    this._service.destroy()
    this.engineStatus.setStatus(EngineStatus.STOP)
  }

  destroyApp() {
    CanvasExportJobRegistry.deactivate(this.appConfig.appId, this.canvasExportOwner)
    DMPAppManager.sharedInstance().exitApp(this.appConfig.appId, this.appIndex)
  }

  invokeUpdateResult() {
    const callbacks = this.onUpdateResults.splice(0)
    callbacks.forEach((callback) => callback())
  }

  onUpdateManagerCall(method: string, arg: DMPMap) {
    arg.set('bridgeId', this.currentWebViewId)
    const msg: DMPMap = new DMPMap({
      type: method,
      body: arg
    })

    if (this._container.isResourceLoaded(this.currentWebViewId)) {
      DMPChannelProxyNext.ContainerToService(msg, this.appIndex)
    } else {
      this.onUpdateResults.push(() => {
        DMPChannelProxyNext.ContainerToService(msg, this.appIndex)
      })
    }
  }

  private startRemoteUpdateCheck() {
    const updateManager = DMPRemoteUpdateManager.sharedInstance()
    const operationToken = updateManager.operationToken(this.appConfig.appId)
    updateManager.checkForUpdate(this, operationToken)
      .catch((error: Error) => {
        DMPLogger.e(Tags.LOAD_REMOTE_BUNDLE, `远程更新检查失败: ${error.message}`)
        this.notifyUpdateManagerStatus('noupdate')
      })
  }

  public notifyUpdateManagerStatus(event: string) {
    const msg: DMPMap = new DMPMap({
      type: 'onUpdateStatusChange',
      body: {
        event,
      }
    })
    this._service.postMessage(msg)
  }

  public getWindowBottomSafeArea(): number {
    if (this._bottomSafeHeight >= 0) {
      return this._bottomSafeHeight
    }
    if (!this.getLaunchConfig()?.bottomSafeArea) {
      this._bottomSafeHeight = 0
      return this._bottomSafeHeight
    }
    this._bottomSafeHeight = DMPWindowUtil.getBottomSafeArea(DMPApp.getWindowStage())
    return this._bottomSafeHeight
  }

  getLaunchConfig(): DMPLaunchConfig | undefined {
    return this.navigatorManager.getCurNavigator()?.getLaunchConfig()
  }

  notifyDomReady(webViewId?: number) {
    let navigatorDelegate = this._navigatorManager.findNavigatorByWebViewId(webViewId)
    if (navigatorDelegate) {
      const launchConfig = navigatorDelegate.getLaunchConfig()
      if (launchConfig?.firstDomReadyListener != null) {
        launchConfig?.firstDomReadyListener()
        launchConfig.firstDomReadyListener = undefined
      }
    }
    if (webViewId) {
      this._navigatorManager.getPageRecordById(webViewId)?.domReadyListeners.forEach((func, i, arr) => {
        func()
      });
    }
  }

  private async startEngineService() {
    DMPLogger.d(Tags.LAUNCH, "startEngineService start");
    // Inject custom API namespaces before loading service.js
    const namespaces = DMPApp._apiNamespaces
    if (namespaces.length > 0) {
      const json = JSON.stringify(namespaces)
      this._service.executeScript(`globalThis.__diminaApiNamespaces = ${json}`)
    }
    // 注入已注册的 API 名字，使 service 层的 wx 对象能枚举到它们
    const registeredApis = this.appModuleManager.getAllRegisteredApiNames()
    if (registeredApis.length > 0) {
      const apisJson = JSON.stringify(registeredApis)
      this._service.executeScript(`globalThis.__diminaRegisteredApis = ${apisJson}`)
    }
    const serviceJsPath = await this._bundleManager.requestServiceJsUri();
    await this._service.loadFileUri(serviceJsPath);
    DMPLogger.i(Tags.LAUNCH, "startEngineService end");
    DMPLogger.d(Tags.LAUNCH, "webViewCachePool init start");
    this._webViewCachePool.init();
    DMPLogger.i(Tags.LAUNCH, "webViewCachePool init end");
  }

  private async startMainService() {
    DMPLogger.d(Tags.LAUNCH, "startMainService start");
    const logicJsPath = await this._bundleManager.requestLogicJsUri();
    await this._service.loadFileUri(logicJsPath);
    DMPLogger.i(Tags.LAUNCH, "startMainService end");
  }

  /**
   * service 侧已经把 logic.js 求值完：loader.loadResource 里先 modRequire('app')（同步跑完
   * App() → runtime.createApp() → App.onLaunch/onShow），再回报 serviceResourceLoaded。
   * 这是唯一能保证 App 实例已存在的信号，窗口期欠下的那次 appHide 在这里补发。
   *
   * startMainService 返回得更早：loadFileUri 只是把 logic.js 投给 Worker，不等求值，
   * 在那里补发会把 appHide 排在 App 实例创建之前，被 runtime.appHide() 的 this.app 判空丢掉。
   */
  public notifyServiceReady() {
    if (this._visibilityLedger.markServiceReady()) {
      this.dispatchAppHide()
    }
  }

  private launchInner(launchConfig: DMPLaunchConfig) {
    DMPLogger.i(Tags.LAUNCH, "launchInner start");
    const appModuleConfig = this.bundleManager.getJsAppModuleConfig()
    if (appModuleConfig.runtimeType === 'game') {
      launchConfig.appEntryPath = appModuleConfig.entryPagePath || 'game'
    }
    if (!launchConfig.appEntryPath) {
      launchConfig.appEntryPath = this.bundleManager.getBundleInfo().currentJsAppBundleConfig?.path;
    }
    if (!launchConfig.appEntryPath) {
      launchConfig.appEntryPath = appModuleConfig.entryPagePath
    }
    // 启动页路径统一去除前导斜杠：宿主 launchConfig / bundle config 的写法不受控，
    // 而 app-config 的 modules / tabBar key 均无前导斜杠。页面内路由都经
    // DataTransformer.parse 归一化，启动链路绕过它，故在此单点补闸，
    // 否则页面配置查找与首页/tabBar 判定会因写法发散
    launchConfig.appEntryPath = launchConfig.appEntryPath?.replace(/^\/+/, '') ?? ''
    if (launchConfig.popListener) {
      this.navigatorManager.registerPopListener(launchConfig.popListener)
    }
    this.navigatorManager.pushNavigator(new DMPNavigatorDelegate(this, launchConfig)).launch()
    DMPLogger.i(Tags.LAUNCH, "launchInner end");
  }
}
