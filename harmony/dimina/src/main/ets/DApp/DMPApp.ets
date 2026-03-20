import { DMPAppConfig, DMPLaunchType } from './config/DMPAppConfig'
import { DMPCustomConfig, DMPLaunchConfig, DMPOpenType } from './config/DMPLaunchConfig'
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
import { ImageKnife } from '@ohos/imageknife'
import { DMPWebViewController } from '../HybridContainer/DMPWebViewController'
import { DMPAppModuleManager } from '../Bridges/DMPAppModuleManager'
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
import { DiminaConfig } from './config/DiminaConfig'

export type DMPBundleUpdateCallback = () => void;
//小程序应用实例
export class DMPApp {
  appIndex: number;
  appConfig: DMPAppConfig
  customConfig: DMPCustomConfig = new DMPCustomConfig();
  private onUpdateResult?: DMPBundleUpdateCallback
  private _container: DMPContainer = new DMPContainer(this)
  private static _context: common.UIAbilityContext
  private _containerBridges: DMPBridges = new DMPBridges()
  private static _entryContext: DMPEntryContext
  private _appModuleManager: DMPAppModuleManager = new DMPAppModuleManager(this)
  private _mapManager: DMPMapManager = new DMPMapManager(this)
  private _webViewCachePool: DMPWebViewCachePool = new DMPWebViewCachePool(this)
  private _service: DMPService
  private _engineStatus: StatusMonitor<EngineStatus> = new StatusMonitor()
  private _render: DMPRender = new DMPRender(this)
  router: DRouter = DRouter.getInstance();

  public get render(): DMPRender {
    return this._render
  }

  constructor(appConfig: DMPAppConfig, appIndex: number) {
    this.appIndex = appIndex;
    this.appConfig = appConfig
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
    return this._appModuleManager
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

  private _bottomSafeHeight = -1

  public get bottomSafeHeight() {
    return this._bottomSafeHeight
  }

  public get currentWebViewId(): number {
    return this.navigatorManager!.getTopPageRecord()?.webViewId ?? -1
  }

  public static getWindowStage(): window.WindowStage {
    return DMPApp._entryContext.getWindowStage();
  }

  static init(context: DMPEntryContext) {
    DMPApp._entryContext = context;
    DMPApp._context = DMPApp._entryContext.getContext();
    ImageKnife.with(DMPApp._entryContext.getContext())
    context.getWindowStage().on('windowStageEvent', DMPAppLifecycle.onWindowStageEvent);
    DMPDeviceUtil.prepareSafeAreaAndDisplayWH(DMPApp._entryContext.getContext())
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

  resetAndStartDimina(config: DMPLaunchConfig) {
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
    this.startPackageLoader(context)
    this.launch(launchConfig)
  }

  async startPackageLoader(context: common.UIAbilityContext) {
    DMPLogger.i(Tags.LAUNCH, 'startPackageLoader start')
    if (this._engineStatus.currentStatus != EngineStatus.RUN &&
      this._engineStatus.currentStatus != EngineStatus.LOADING) { // 已经启动jsEngine
      this._engineStatus.setStatus(EngineStatus.LOADING)
      DMPContextUtils.init(context)
      let fileManager: DMPFileManager = DMPFileManager.sharedInstance()
      fileManager.createLocalBundleDirectoryForApp(this.appConfig.appId)
      let installConfig =
        new DMPBundleInstallConfig(DMPContextUtils.getUIAbilityContext(), this.appConfig.appId, this.appIndex);
      installConfig.launchAppType = this.appConfig.launchAppType;

      let waitLaunchBundleReady = async (config: DMPBundleLoadInfo) => {
        DMPLogger.i(Tags.LAUNCH, "launchBundleReady: launchType: " + DMPLaunchType[installConfig.launchAppType]);
        await this._bundleManager.loadConfigFile()
        this._service.updateWorkerAppData();
        await this.startEngineService()
        await this.startMainService()

        this._engineStatus.setStatus(EngineStatus.RUN)
      };

      const loadComplete = (config: DMPBundleLoadInfo) => {

      }
      //安装小程序包
      this._bundleManager.install(installConfig, waitLaunchBundleReady, loadComplete)
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

  public closeDimina() {
    this.destroyEngine()
    this.destroyApp()
    DMPLogger.i(Tags.LAUNCH, 'Doing something in closeApp')
  }

  public hiApp() {
    DMPLogger.i(Tags.LAUNCH, 'Doing something in closeApp')
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

  destroyEngine() {
    this._service.destroy()
    this.engineStatus.setStatus(EngineStatus.STOP)
  }

  destroyApp() {
    DMPAppManager.sharedInstance().exitApp(this.appConfig.appId)
  }

  invokeUpdateResult() {
    if (this.onUpdateResult) {
      this.onUpdateResult()
      this.onUpdateResult = undefined
    }
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
      this.onUpdateResult = () => {
        DMPChannelProxyNext.ContainerToService(msg, this.appIndex)
      }
    }
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
    const namespaces = DiminaConfig.shared.apiNamespaces
    if (namespaces.length > 0) {
      const json = namespaces.map((n: string) => `"${n}"`).join(",")
      this._service.executeScript(`globalThis.__diminaApiNamespaces = [${json}]`)
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
    if (launchConfig.completion) {
      launchConfig.completion(true)
      launchConfig.completion = undefined
    }
    if (!launchConfig.appEntryPath) {
      launchConfig.appEntryPath = this.bundleManager.getBundleInfo().currentJsAppBundleConfig?.path;
    }
    if (!launchConfig.appEntryPath) {
      launchConfig.appEntryPath = this.bundleManager.getJsAppModuleConfig().entryPagePath
    }
    if (launchConfig.popListener) {
      this.navigatorManager.registerPopListener(launchConfig.popListener)
    }
    this.navigatorManager.pushNavigator(new DMPNavigatorDelegate(this, launchConfig)).launch()
    DMPLogger.i(Tags.LAUNCH, "launchInner end");
  }
}
