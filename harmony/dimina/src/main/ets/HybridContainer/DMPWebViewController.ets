import web_webview from '@ohos.web.webview'
import { DMPApp } from '../DApp/DMPApp'
import { DMPLaunchType } from '../DApp/config/DMPAppConfig'
import { WebViewLifeCycle } from './DMPWebViewLifeCycle'
import { DMPWebComponent } from './DMPWebComponent'
import { DMPWebViewProxy } from './DMPWebViewProxy'
import { DMPContextUtils } from '../Utils/DMPContextUtils'

const DMP_DEFAULT_PAGE_FRAME: string = 'pageFrame.html'

interface DMPJavaScriptProxy {
  object: object;
  name: string;
  methodList: Array<string>;
  asyncMethodList: Array<string>;
  controller: WebviewController;
}

export class DMPWebViewController extends web_webview.WebviewController {
  webViewId: number
  private webViewProxy: DMPWebViewProxy
  webContainer: DMPWebComponent | undefined | null
  app: DMPApp;
  subController?: DMPWebViewController;
  webViewLifeCycle: WebViewLifeCycle = new WebViewLifeCycle()
  isPageEnd: Boolean = false;
  isControllerAttached: boolean = false;

  constructor(webViewId: number, app: DMPApp) {
    super()
    this.app = app
    this.webViewId = webViewId
    // Cannot read property appIndex of undefined
    this.webViewProxy = new DMPWebViewProxy(this.webViewId, app.appIndex)
  }

  // 老 api，只能注册一个对象
  genProxy() {
    let jsp: DMPJavaScriptProxy = {
      object: this.webViewProxy,
      name: "DiminaRenderBridge",
      methodList: ["invoke"],
      asyncMethodList: ["publish"],
      controller: this
    }

    return jsp
  }

  getWebViewProxy() {
    return this.webViewProxy
  }

  //公共配置
  initConfig() {
    this.setCustomUserAgent(`${this.getUserAgent()} dimina miniProgram ${this.app.appConfig?.userAgent ?? ''}`);
  }

  loadPath(): string {
    let app: DMPApp = this.app;
    let path: string = '';
    const vConsoleQuery = (app.appConfig.isDebugMode || DMPContextUtils.debugMode) ? '?vconsole=1' : '';

    if (app.appConfig.launchAppType === DMPLaunchType.DebugUrl) {
      const mainPkgPath = app.bundleManager.getCurrentJSSdkDir();
      const pagePath = DMP_DEFAULT_PAGE_FRAME;
      const path = `${mainPkgPath}/${pagePath}${vConsoleQuery}`
      return path;
    } else {
      path = `http://127.0.0.1/pageFrame.html${vConsoleQuery}`;
    }

    return path;
  }

  notifyPageEnd() {
    this.isPageEnd = true;
    this.webViewLifeCycle.notifyPageEnd()
  }

  notifyPageBegin() {
    this.isPageEnd = false;
    this.webViewLifeCycle.notifyPageBegin()
  }

  notifyControllerAttached() {
    this.isControllerAttached = true;
    this.initConfig()
    this.app.render.flushPendingScripts(this.webViewId)
  }

  notifyControllerDetached() {
    this.isControllerAttached = false;
  }
}
