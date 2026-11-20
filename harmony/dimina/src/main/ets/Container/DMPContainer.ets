import { DMPBridges } from '../Bridges/DMPBridges';
import { DMPRuntimeDiagnostics } from '../EventTrack/DMPRuntimeDiagnostics';
import { DMPApp } from '../DApp/DMPApp';
import { DMPChannelProxyNext } from '../Service/DMPChannelProxyNext';
import { DMPMap } from '../Utils/DMPMap';
import { DMPContextUtils } from '../Utils/DMPContextUtils';
import { DMPHostEnvBuilder } from '../Utils/DMPHostEnvBuilder';

export enum ResourceLoadType {
  Init = 0 << 0,
  ServiceLoaded = 1 << 0,
  RenderLoaded = 1 << 1,
  AllLoaded = 3 << 0
}

export class DMPContainer {
  app: DMPApp;
  isNavigating: boolean = false;
  private loadStatusMap: Map<number, ResourceLoadType> = new Map();

  constructor(app: DMPApp) {
    this.app = app
  }

  resetStatus() {
    this.isNavigating = false
  }

  hasLoadResource(webViewId: number, type: ResourceLoadType) {
    let status: ResourceLoadType = this.loadStatusMap.get(webViewId) ?? ResourceLoadType.Init;
    status = status | type;
    this.loadStatusMap.set(webViewId, status);
  }

  isResourceLoaded(webViewId: number) {
    return this.loadStatusMap.get(webViewId) === ResourceLoadType.AllLoaded;
  }

  public loadResourceService(webViewId: number, pagePath: string) {
    const appConfig = this.app?.bundleManager.getJsAppModuleConfig()
    const root = appConfig?.getRootPackage(pagePath)
    const navigator = this.app.navigatorManager.findNavigatorByWebViewId(webViewId)
    const launchConfig = navigator?.getLaunchConfig()
    const pageRecord = this.app.navigatorManager.getPageRecordById(webViewId)

    const msg: DMPMap = new DMPMap({
      type: 'loadResource',
      body: {
        bridgeId: webViewId,
        appId: this.app.appConfig.appId,
        pagePath: pagePath,
        runtimeType: appConfig?.runtimeType ?? 'miniProgram',
        debugEnabled: (DMPContextUtils.debugMode || this.app.appConfig.isDebugMode) ? 'true' : 'false',
        query: pageRecord?.params?.get('query') ?? new DMPMap(),
        scene: launchConfig?.scene,
        referrerInfo: launchConfig?.referrerInfo,
        root: root,
        hostEnv: DMPHostEnvBuilder.buildSnapshot(this.app),
      }
    })

    DMPChannelProxyNext.ContainerToService(msg, this.app.appIndex)
  }

  public loadResourceRender(webViewId: number, pagePath: string) {
    const appConfig = this.app?.bundleManager.getJsAppModuleConfig()
    const root = appConfig?.getRootPackage(pagePath)
    const msg: DMPMap = new DMPMap({
      type: 'loadResource',
      body: {
        bridgeId: webViewId,
        appId: this.app.appConfig.appId,
        pagePath: pagePath,
        runtimeType: appConfig?.runtimeType ?? 'miniProgram',
        debugEnabled: (DMPContextUtils.debugMode || this.app.appConfig.isDebugMode) ? 'true' : 'false',
        root: root
      }
    })

    DMPChannelProxyNext.ContainerToRender(msg, this.app, webViewId)
  }

  public updateHostEnv(): void {
    let hasLoadedService: boolean = false
    this.loadStatusMap.forEach((status: ResourceLoadType) => {
      if ((status & ResourceLoadType.ServiceLoaded) !== 0) {
        hasLoadedService = true
      }
    })
    if (!hasLoadedService) {
      return
    }

    const msg: DMPMap = new DMPMap({
      type: 'hostEnvUpdate',
      body: DMPHostEnvBuilder.buildSnapshot(this.app)
    })
    DMPChannelProxyNext.ContainerToService(msg, this.app.appIndex)
  }

  public callBridgeMethods(methodName: string, webViewId: number,
    params: DMPMap | number | string | boolean | object, app: DMPApp): number | string | boolean | object {
    const call = DMPRuntimeDiagnostics.beginCall(methodName, app.appConfig.appId,
      app.navigatorManager?.getPageRecordById(webViewId)?.pagePath, String(webViewId))
    return DMPBridges.callMethodsNext(methodName, webViewId, params, app.appIndex, app.appModuleManager, call)
  }

  public callWebviewBridgeMethods(methodName: string, webViewId: number,
    params: DMPMap | number | string | boolean | object, app: DMPApp): DMPMap | number | string | boolean | object {
    return DMPBridges.callWebViewMethods(methodName, webViewId, params, app)
  }
}
