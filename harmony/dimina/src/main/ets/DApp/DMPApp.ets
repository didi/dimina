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
import { DRouter } from '../Navigator/DRouter'
import { DMPAppLifecycle } from './DMPAppLifecycle'
import { DMPDeviceUtil } from '../Utils/DMPDeviceUtils'
import { DMPRemoteUpdateManager } from '../Bundle/DMPRemoteUpdateManager'
import { DMPWebSocketManager } from '../Bridges/Network/DMPWebSocketManager'
import { DMPAppModuleManagerLifecycle } from '../Bridges/DMPAppModuleManagerLifecycle'
import { DMPPageLifecycle } from '../DPages/DMPPageLifecycle'
import { DMPPageOrientationCapability } from '../DPages/DMPPageOrientationCapability'
export type DMPBundleUpdateCallback = () => void;

export interface DMPAppInitOptions {
  apiNamespaces?: string[];
  /** Disabled by default so an SDK upgrade does not change the host window's orientation policy. */
  pageOrientationEnabled?: boolean;
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
  private static _pageOrientationEnabled: boolean = false
  private _containerBridges: DMPBridges = new DMPBridges()
  private static _entryContext: DMPEntryContext
  private static _isInitialized: boolean = false
  private _appModuleManagerLifecycle: DMPAppModuleManagerLifecycle
  private _mapManager: DMPMapManager = new DMPMapManager(this)
  private _runtimeGeneration: number = 0
  private _webViewCachePool: DMPWebViewCachePool = new DMPWebViewCachePool(this)
  private _service: DMPService
  private _engineStatus: StatusMonitor<EngineStatus> = new StatusMonitor()
  private _render: DMPRender = new DMPRender(this)
  /**
   * 这个小程序最近一次报给 service 的窗口几何，形如 `宽x高@方向`；空串表示还没报过。
   * 按小程序存而不按页存：窗口只有一个，页面通道由上报时指名的 bridgeId 决定收件人。
   */
  lastReportedGeometry: string = ''
  router: DRouter = DRouter.getInstance();

  private static readonly deviceMetricsChangeCallback = (_metrics: DMPMap): void => {
    DMPAppManager.sharedInstance().appPools.forEach((app: DMPApp) => {
      app.container.updateHostEnv()
    })
  }

  // 窗口尺寸/避让区变化时，按当前拥有共享窗口的 app 的栈顶页上报这次已经生效的几何，再重新解算方向；这是「布局确实变了」的唯一信号，方向类 pageResize 只从这里发出。
  // 与 deviceMetricsChangeCallback 是同一订阅点的两个独立回调，不把这条逻辑塞进 updateHostEnv（那条按设计要影响 theme 等既有订阅方的所有 app，见 DMPPageLifecycle.applyOrientation）。
  // appPools 里可能同时驻留多个 app 实例（切回小程序列表又打开另一个，旧的并未退出），但窗口只有一个——只认 DMPAppManager 记录的那个前台 app，不再遍历 appPools 给每个 app 都发一遍，否则后台 app 会替可见 app 抢窗口、隐藏 app 的业务代码也会收到它并不拥有的几何变化
  private static readonly pageOrientationMetricsChangeCallback = (_metrics: DMPMap): void => {
    const foregroundApp = DMPAppManager.sharedInstance().getForegroundApp()
    if (!foregroundApp) {
      return
    }
    const webViewId = foregroundApp.currentWebViewId
    const navigator = foregroundApp.navigatorManager.findNavigatorByWebViewId(webViewId)
      ?? foregroundApp.navigatorManager.getCurNavigator()
    // 押着的 pageShow 先放行：service 只把已经 show 的页面登记成 Page.onResize 的收件人。
    // 放行了就是一次路由落地，那条上报不比对几何；否则这只是一次窗口事件，几何没动就不该惊动业务代码（同一条订阅上还挂着键盘、状态栏）。
    const released: boolean =
      navigator?.getNavigator().pageLifecycle.flushPendingPageShow(webViewId) ?? false
    if (released) {
      DMPPageLifecycle.reportRouteGeometry(foregroundApp, webViewId)
    } else {
      DMPPageLifecycle.reportGeometryIfChanged(foregroundApp, webViewId)
    }
    DMPPageLifecycle.applyOrientation(foregroundApp, webViewId)
  }

  /**
   * 拿到窗口归属时把栈顶页的方向重新按给窗口。
   * 归属转移的判定在 DMPAppManager，方向的解算在 DMPPageLifecycle——两边都已经依赖 DMPApp，从这里转一手就不用互相导入。
   */
  applyCurrentPageOrientation(): void {
    DMPPageLifecycle.applyOrientation(this, this.currentWebViewId)
  }

  public get render(): DMPRender {
    return this._render
  }

  constructor(appConfig: DMPAppConfig, appIndex: number) {
    this.appIndex = appIndex;
    this.appConfig = appConfig
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

  static isPageOrientationEnabled(): boolean {
    return DMPApp._pageOrientationEnabled
  }

  static init(context: DMPEntryContext, options?: DMPAppInitOptions) {
    // 同一进程里 WindowStage 可能被销毁后重建；先拆旧账本，确保每个 owner 只有一组 windowStage/metrics 监听，不能让重复 init 线性累积回调。
    DMPApp.dispose()
    DMPApp._entryContext = context;
    DMPApp._context = DMPApp._entryContext.getContext();
    DMPApp._apiNamespaces = options?.apiNamespaces ?? [];
    DMPApp._pageOrientationEnabled =
      DMPPageOrientationCapability.isEnabled(options?.pageOrientationEnabled)
    // 从这里起 dispose 已有足够的 owner 信息可回收部分初始化留下的订阅。
    DMPApp._isInitialized = true
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
    if (DMPApp._pageOrientationEnabled) {
      DMPDeviceUtil.addMetricsChangeListener(DMPApp.pageOrientationMetricsChangeCallback)
    }
  }

  /** WindowStage owner teardown; safe to call repeatedly. */
  static dispose(): void {
    if (!DMPApp._isInitialized) {
      return
    }
    try {
      DMPApp._entryContext.getWindowStage().off('windowStageEvent', DMPAppLifecycle.onWindowStageEvent)
    } catch (_) {
    }
    DMPDeviceUtil.removeMetricsChangeListener(DMPApp.deviceMetricsChangeCallback)
    DMPDeviceUtil.removeMetricsChangeListener(DMPApp.pageOrientationMetricsChangeCallback)
    DMPDeviceUtil.releaseWindowObservation()
    DMPApp._pageOrientationEnabled = false
    DMPApp._isInitialized = false
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
      this.navigatorManager.closeAllNavigators(false)
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
    this.notifyMiniProgramHide()
    this.navigatorManager.closeAllNavigators(false)
    // pageUnload and any terminal API callback are queued to the Worker. Drain them before
    // terminating the old runtime; a fixed timeout cannot provide this ordering guarantee.
    await this._service.flush()
    this.destroyEngine()
    this.resetAndStartDimina(nextLaunchConfig)
  }

  resetAndStartDimina(config: DMPLaunchConfig) {
    this.onUpdateResults = []
    this._runtimeGeneration++
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
    this.startDimina(DMPContextUtils.getUIAbilityContext(), config);
  }

  updateApp() {
    DMPLogger.i(Tags.LAUNCH, "updateApp invoke")
    DRouter.getInstance().popToRoot()
    const curNavigator = this.navigatorManager.getCurNavigator();
    const curLaunchConfig = curNavigator!.getLaunchConfig()
    this.navigatorManager?.clear()
    this.destroyEngine();
    setTimeout(() => {
      this.resetAndStartDimina(curLaunchConfig)
    }, 300);
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

  public async closeDimina(afterPagesClosed?: () => Promise<void>) {
    this.notifyMiniProgramHide()
    this.navigatorManager.closeAllNavigators(false)
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
    const bridgeId = this.currentWebViewId
    if (bridgeId > 0) {
      DMPChannelProxyNext.ContainerToService(new DMPMap({
        type: 'pageHide',
        body: { bridgeId }
      }), this.appIndex)
    }
    DMPChannelProxyNext.ContainerToService(new DMPMap({
      type: 'appHide',
      body: { bridgeId }
    }), this.appIndex)
  }

  /** Reveal only this mini program and update App.onShow/GetEnterOptionsSync data. */
  public notifyMiniProgramShow(scene: DMPScene, referrerInfo?: DMPMap) {
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
      DMPChannelProxyNext.ContainerToService(new DMPMap({
        type: 'pageShow',
        body: { bridgeId }
      }), this.appIndex)
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
    // Invalidate bundle/bootstrap callbacks and delayed cache work before disposing their owners.
    this._runtimeGeneration++
    // 销毁前取消所有 extOnBridge 订阅，防止内存泄漏
    this._appModuleManagerLifecycle.disposeCurrent();
    // 先于 service 销毁：静默清理该 appId 全部 WebSocket 连接/监听/定时器，杜绝事件竞入将死引擎
    DMPWebSocketManager.sharedInstance().disposeOwner(this.appConfig.appId);
    this._service.destroy()
    this.engineStatus.setStatus(EngineStatus.STOP)
  }

  destroyApp() {
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
    DMPRemoteUpdateManager.sharedInstance()
      .checkForUpdate(this)
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
