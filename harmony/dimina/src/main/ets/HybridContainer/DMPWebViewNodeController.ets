import { DMPWebComponent } from './DMPWebComponent';
import { BuilderNode, FrameNode, NodeController } from '@kit.ArkUI';
import { DMPMap } from '../Utils/DMPMap';
import { DMPApp } from '../DApp/DMPApp';
import { WebViewLifeCycleListener } from './DMPWebViewLifeCycle';
import { DMPLogger } from '../EventTrack/DMPLogger';
import { Tags } from '../EventTrack/Tags';


export class NodeControllerWrapper {
  pagePath: string
  query: DMPMap
  webViewNodeController: DMPWebViewNodeController

  constructor(pagePath: string, query: DMPMap, webViewNodeController: DMPWebViewNodeController) {
    this.pagePath = pagePath;
    this.query = query;
    this.webViewNodeController = webViewNodeController;
  }
}

class DMPWebComponentParam {
  webViewId?: number
  appIndex?: number
}

@Builder
function WebBuilder(param: DMPWebComponentParam) {
  Column() {
    DMPWebComponent({ webViewId: param.webViewId, appIndex: param.appIndex })
  }
}

let wrap = wrapBuilder<DMPWebComponentParam[]>(WebBuilder);

export class DMPWebViewNodeController extends NodeController {
  private rootNode: BuilderNode<DMPWebComponentParam[]> | null = null;
  private app: DMPApp
  readonly webViewId: number
  private isLoadResource: boolean = false;

  constructor(webViewId: number, app: DMPApp) {
    super();
    this.webViewId = webViewId;
    this.app = app;
  }

  loadResource(pagePath: string) {
    DMPLogger.d(Tags.LAUNCH, "loadResource start")
    const webViewController = this.app.render.getController(this.webViewId);

    // 如果页面已经结束，直接加载资源
    if (webViewController.isPageEnd) {
      DMPLogger.d(Tags.PRE_LOAD, 'webViewController.isPageEnd loadResource')
      this.loadWebViewResource(pagePath);
      return;
    }

    class InnerListenerImpl implements WebViewLifeCycleListener {
      loadResourceFn: () => void

      constructor(loadResourceFn: () => void) {
        this.loadResourceFn = loadResourceFn
      }

      pageStart(): void {
        DMPLogger.d(Tags.LAUNCH, "webview pageStart")
      }

      pageEnd(): void {
        DMPLogger.d(Tags.PRE_LOAD, 'webview pageEnd loadResource')
        DMPLogger.d(Tags.LAUNCH, "webview pageEnd")
        webViewController.webViewLifeCycle.unregisterListener(this);
        this.loadResourceFn();
      }
    }

    DMPLogger.d(Tags.PRE_LOAD, 'wait webViewController pageEnd')
    // 创建监听器实例并注册
    const listener = new InnerListenerImpl((): void => this.loadWebViewResource(pagePath));
    webViewController.webViewLifeCycle.registerListener(listener);
  }

  private loadWebViewResource(pagePath: string) {
    if (this.isLoadResource) {
      DMPLogger.i(Tags.PRE_LOAD, '页面资源已经预加载完成')
      return;
    }
    this.isLoadResource = true;
    this.app.container.loadResourceService(this.webViewId, pagePath);
    this.app.container.loadResourceRender(this.webViewId, pagePath);
    DMPLogger.i(Tags.LAUNCH, "loadResource end")
  }

  makeNode(uiContext: UIContext): FrameNode | null {
    DMPLogger.i(Tags.PRE_LOAD, "DMPWebViewNodeController uicontext is undefined : " + (uiContext === undefined));
    if (this.rootNode != null) {
      return this.rootNode.getFrameNode();
    }
    return null;
  }

  aboutToResize(size: Size) {
    DMPLogger.d(Tags.PRE_LOAD,
      "DMPWebViewNodeController aboutToResize width : " + size.width + " height : " + size.height);
  }

  aboutToAppear() {
    DMPLogger.d(Tags.PRE_LOAD, "DMPWebViewNodeController aboutToAppear");
  }

  aboutToDisappear() {
    DMPLogger.d(Tags.PRE_LOAD, "DMPWebViewNodeController aboutToDisappear");
  }

  initWeb(uiContext: UIContext, webViewId: number, appIndex: number) {
    if (this.rootNode != null) {
      return;
    }
    this.rootNode = new BuilderNode(uiContext);
    this.rootNode.build(wrap, { webViewId: this.webViewId, appIndex: appIndex });
  }

  dispose() {
    if (this.rootNode) {
      this.rootNode.dispose()
    }
  }
}
