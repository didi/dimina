import { util } from '@kit.ArkTS'
import web_webview from '@ohos.web.webview'
import { DMPApp } from '../DApp/DMPApp'
import { DMPLaunchType } from '../DApp/config/DMPAppConfig'
import { WebViewLifeCycle } from './DMPWebViewLifeCycle'
import { DMPWebComponent } from './DMPWebComponent'
import { DMPWebViewProxy } from './DMPWebViewProxy'
import { DMPContextUtils } from '../Utils/DMPContextUtils'
import { inputMethod } from '@kit.IMEKit'
import { DMPAppManager } from '../DApp/DMPAppManager'
import { DMPLogger } from '../EventTrack/DMPLogger'
import { Tags } from '../EventTrack/Tags'
import { keyboardFocusCheck } from './DMPKeyboardFocus'

const DMP_DEFAULT_PAGE_FRAME: string = 'pageFrame.html'

interface DMPJavaScriptProxy {
  object: object;
  name: string;
  methodList: Array<string>;
  asyncMethodList: Array<string>;
  controller: WebviewController;
}

export class DMPWebViewController extends web_webview.WebviewController {
  readonly nativeWebTag: string
  webViewId: number
  private webViewProxy: DMPWebViewProxy
  webContainer: DMPWebComponent | undefined | null
  app: DMPApp;
  subController?: DMPWebViewController;
  webViewLifeCycle: WebViewLifeCycle = new WebViewLifeCycle()
  isPageEnd: Boolean = false;
  isControllerAttached: boolean = false;
  private keyboardGeneration: number = 0
  private pendingKeyboardRevision: number | undefined

  constructor(webViewId: number, app: DMPApp, nativeWebTag: string = 'dimina-' + util.generateRandomUUID()) {
    super(nativeWebTag)
    this.nativeWebTag = nativeWebTag
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
      asyncMethodList: ["publish", "requestKeyboard"],
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
    const vConsoleQuery = (DMPContextUtils.debugMode || app.appConfig.isDebugMode) ? '?vconsole=1' : '';

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
    this.app.render.invalidateCanvasUi(this.webViewId, this)
    this.cancelFocusedKeyboard()
    this.isPageEnd = false;
    this.webViewLifeCycle.notifyPageBegin()
  }

  notifyControllerAttached() {
    this.isControllerAttached = true;
    this.initConfig()
    this.app.render.flushPendingScripts(this.webViewId)
  }

  notifyControllerDetached() {
    this.app.render.invalidateCanvasUi(this.webViewId, this)
    this.cancelFocusedKeyboard()
    this.isControllerAttached = false;
  }

  private canShowKeyboard(): boolean {
    const manager = DMPAppManager.sharedInstance()
    return this.isControllerAttached && manager.isHostVisible()
      && manager.getPresentedApp() === this.app
      && this.app.currentWebViewId === this.webViewId
      && !this.app.navigatorManager.isRetainedInBackground
      && this.webContainer !== undefined && this.webContainer !== null
      && !this.webContainer.modalInteractionBlocked
  }

  async showFocusedKeyboard(revision: number): Promise<void> {
    if (!Number.isSafeInteger(revision) || !this.canShowKeyboard()) return
    this.keyboardGeneration++
    this.pendingKeyboardRevision = revision
    try {
      this.requestFocus()
      await this.flushFocusedKeyboard()
    } catch (error) {
      this.cancelFocusedKeyboard()
      DMPLogger.w(Tags.DMP_WEB_COMPONENT, 'Unable to focus input container: ' + String(error))
    }
  }

  cancelFocusedKeyboard(): void {
    this.keyboardGeneration++
    this.pendingKeyboardRevision = undefined
  }

  async flushFocusedKeyboard(): Promise<void> {
    if (this.pendingKeyboardRevision === undefined || !this.canShowKeyboard()
      || !this.webContainer?.hasWebFocus) return
    const revision = this.pendingKeyboardRevision
    const generation = this.keyboardGeneration
    this.pendingKeyboardRevision = undefined
    try {
      // The evaluation acknowledges the DOM focus and rejects stale focus/blur requests.
      const focused = await this.runJavaScript(keyboardFocusCheck(revision))
      if (focused !== 'true' || generation !== this.keyboardGeneration || !this.canShowKeyboard()
        || !this.webContainer?.hasWebFocus) return
      await inputMethod.getController().showTextInput()
    } catch (error) {
      DMPLogger.w(Tags.DMP_WEB_COMPONENT, 'Unable to show focused input keyboard: ' + String(error))
    }
  }
}
