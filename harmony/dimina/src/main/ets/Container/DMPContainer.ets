import { DMPBridges } from '../Bridges/DMPBridges';
import { DMPApp } from '../DApp/DMPApp';
import { DMPChannelProxyNext } from '../Service/DMPChannelProxyNext';
import { DMPMap } from '../Utils/DMPMap';
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
    const root = this.app?.bundleManager.getJsAppModuleConfig()?.getRootPackage(pagePath)

    const msg: DMPMap = new DMPMap({
      type: 'loadResource',
      body: {
        bridgeId: webViewId,
        appId: this.app.appConfig.appId,
        pagePath: pagePath,
        root: root,
        hostEnv: DMPHostEnvBuilder.buildSnapshot(this.app),
      }
    })

    DMPChannelProxyNext.ContainerToService(msg, this.app.appIndex)
  }

  public loadResourceRender(webViewId: number, pagePath: string) {
    const root = this.app?.bundleManager.getJsAppModuleConfig()?.getRootPackage(pagePath)
    const msg: DMPMap = new DMPMap({
      type: 'loadResource',
      body: {
        bridgeId: webViewId,
        appId: this.app.appConfig.appId,
        pagePath: pagePath,
        root: root
      }
    })

    DMPChannelProxyNext.ContainerToRender(msg, this.app, webViewId)
  }

  public callBridgeMethods(methodName: string, webViewId: number,
    params: DMPMap | number | string | boolean | object, app: DMPApp): number | string | boolean | object {
    return DMPBridges.callMethodsNext(methodName, webViewId, params, app.appIndex, app.appModuleManager)
  }

  public callWebviewBridgeMethods(methodName: string, webViewId: number,
    params: DMPMap | number | string | boolean | object, app: DMPApp): DMPMap | number | string | boolean | object {
    return DMPBridges.callWebViewMethods(methodName, webViewId, params, app)
  }
}