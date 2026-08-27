import { DMPAppManager } from '../DApp/DMPAppManager';
import { DMPApp } from '../DApp/DMPApp';
import { DMPScene } from '../DApp/config/DMPLaunchConfig';
import { DMPLogger } from '../EventTrack/DMPLogger';
import { DMPMap } from '../Utils/DMPMap';
import { DMPPageRecord } from '../Navigator/DMPPageRecord';
import { ResourceLoadType } from '../Container/DMPContainer';
import { Tags } from '../EventTrack/Tags';

export class DMPChannelProxyNext {
  public static messageHandlerNext(type: string, body: DMPMap,
    target: string, app: DMPApp): DMPMap | number | string | boolean | object {
    // DMPLogger.d(Tags.LAUNCH, `messageHandlerNext:type=${type} target=${target} methodName=${body.get('name')}`)
    DMPLogger.i(Tags.LAUNCH, `messageHandlerNext:type=${type} target=${target} methodName=${body.get('name')} bridgeId=${body.get('bridgeId')}`)
    let transMsg = new DMPMap({
      'type': type,
      'body': body
    })

    const webViewId: number = body.get('bridgeId');
    const pageRecord: DMPPageRecord | undefined = app.navigatorManager?.getPageRecordById(webViewId)
    if (webViewId && pageRecord) {
      body.set('pagePath', pageRecord.pagePath);
      body.set('query', pageRecord.params?.get('query'));
    }

    if (target === 'service') {
      if (type === 'serviceResourceLoaded') {
        // service 侧 App 实例此刻必定已存在，补发启动窗口期欠下的 appHide。渲染层可能还没就绪
        // （isResourceLoaded 为 false），所以放在分支之外，不跟着 resourceLoaded 一起等。
        app.notifyServiceReady();
        app.container.hasLoadResource(webViewId, ResourceLoadType.ServiceLoaded);
        if (app.container.isResourceLoaded(webViewId)) {
          transMsg.set('type', 'resourceLoaded');
          const body: DMPMap = transMsg.get('body');
          const navigator = app.navigatorManager.findNavigatorByWebViewId(webViewId)
          const launchConfig = navigator?.getLaunchConfig()
          body.set('scene', launchConfig?.scene ?? DMPScene.fromMainEntry);
          if (launchConfig?.referrerInfo) {
            body.set('referrerInfo', launchConfig.referrerInfo)
          }
          body.set('stackId', navigator?.id)
          app.service.postMessage(transMsg);
          app.container.resetStatus()
          app.invokeUpdateResult()
          DMPLogger.i(Tags.LAUNCH,'send resourceLoaded')
          return new DMPMap();
        } else {
          DMPLogger.i(Tags.LAUNCH,'isResourceLoaded false')
          return new DMPMap();
        }
      } else if (type == 'renderResourceLoaded') {
        app.container.hasLoadResource(webViewId, ResourceLoadType.RenderLoaded);
        if (app.container.isResourceLoaded(webViewId)) {
          transMsg.set('type', 'resourceLoaded');
          const body: DMPMap = transMsg.get('body');
          const navigator = app.navigatorManager.findNavigatorByWebViewId(webViewId)
          const launchConfig = navigator?.getLaunchConfig()
          body.set('scene', launchConfig?.scene ?? DMPScene.fromMainEntry);
          if (launchConfig?.referrerInfo) {
            body.set('referrerInfo', launchConfig.referrerInfo)
          }
          body.set('stackId', navigator?.id)
          app.service.postMessage(transMsg);
          app.container.resetStatus()
          app.invokeUpdateResult()
          DMPLogger.i(Tags.LAUNCH,'send resourceLoaded')
          return new DMPMap();
        } else {
          DMPLogger.i(Tags.LAUNCH,'isResourceLoaded false')
          return new DMPMap();
        }
      }
      app.service.postMessage(transMsg);
    } else if (target === 'container') {
      if (type === 'invokeAPI') {
        const name: string = body.get('name');

        if (typeof body.get('params') == 'string' || typeof body.get('params') == 'number' ||
          typeof body.get('params') == 'boolean' || Array.isArray(body.get('params'))) {
          return app.container.callBridgeMethods(name, webViewId, body.get('params'), app)
        } else {
          return app.container.callBridgeMethods(name, webViewId,
            DMPMap.createFromObject(body.get('params')), app)
        }
      } else if (type === 'domReady') {
        app.container.isNavigating = false
        app.notifyDomReady(webViewId)
        DMPLogger.i(Tags.LAUNCH, "domReady")
      }
    } else if (target === 'webview') {
      // 处理 来自h5 jssdk 的消息
      if (type === 'invokeAPI') {
        const name: string = body.get('name');

        if (typeof body.get('params') == 'string' || typeof body.get('params') == 'number' ||
          typeof body.get('params') == 'boolean' || Array.isArray(body.get('params'))) {
          return app.container.callWebviewBridgeMethods(name, webViewId, body.get('params'), app)
        } else {
          return app.container.callWebviewBridgeMethods(name, webViewId,
            DMPMap.createFromObject(body.get('params')), app)
        }
      }
    }

    return new DMPMap();
  }

  public static ContainerToService(data: DMPMap, appIndex: number) {
    // DMPLogger.d(Tags.BRIDGE, `ContainerToService ${data.toStr()} `)
    const app = DMPAppManager.sharedInstance().getApp(appIndex)
    if (app) {
      app.service.fromContainerNext(data);
    } else {
      DMPLogger.d(Tags.BRIDGE, `ContainerToService消息失效, appIndex:${appIndex},${data.toStr()}`)
    }
  }

  public static ContainerToRender(data: DMPMap, app: DMPApp, webViewId: number) {
    // DMPLogger.d(Tags.BRIDGE, `ContainerToRender ${data.toStr()} `)
    if (app) {
      app.render.fromContainerNext(data, webViewId)
    }
  }

  public static ContainerToWebviewRender(data: DMPMap, app: DMPApp, webViewId: number) {
    // DMPLogger.d(Tags.BRIDGE, `ContainerToWebviewRender ${data.toStr()} `)
    if (app) {
      app.render.fromWebviewNext(data, webViewId)
    }
  }

  public static messageHandlerWithAppIndex(type: string, body: DMPMap,
    target: string, appIndex: number): DMPMap | number | string | boolean | object {
    const app = DMPAppManager.sharedInstance().getApp(appIndex);
    if (app) {
      return DMPChannelProxyNext.messageHandlerNext(type, body, target, app);
    } else {
      return new DMPMap();
    }
  }

  // 不再解析直接透传
  public static ServiceToRenderWithAppIndex(dataString: string, webViewId: number, appIndex: number) {
    // DMPLogger.d(Tags.BRIDGE, `ServiceToRenderWithAppIndex ${dataString} `);
    const app = DMPAppManager.sharedInstance().getApp(appIndex);
    if (app) {
      app.render.fromServiceNext(dataString, webViewId);
    } else {
      DMPLogger.d(Tags.BRIDGE, `ServiceToRender消息失效, appIndex:${appIndex},webviewId:${Number},${dataString}`)
    }
    return 0;
  }

  // 不再解析直接透传
  public static RenderToService(dataString: string, app: DMPApp) {
    // DMPLogger.d(Tags.BRIDGE, `RenderToService ${dataString} `);
    if (app) {
      app.service.fromRender(dataString);
    }
  }
}
