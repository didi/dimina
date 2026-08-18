
import { DMPWebViewProxy } from '../../HybridContainer/DMPWebViewProxy';
import { DMPWebViewController } from '../../HybridContainer/DMPWebViewController';
import { DMPAppManager } from '../../DApp/DMPAppManager';
import { DMPMap } from '../../Utils/DMPMap';
import { DMPStringUtils } from '../../Utils/DMPStringUtils'

import { WebViewParams } from './DMPComponetParams';
import { DMPPageStyle } from '../../DPages/DMPPageStyle';
import { DMPNavigatorDelegate } from '../../Navigator/DMPNavigatorDelegate';
import { DMPNavigatorManager } from '../../Navigator/DMPNavigatorManager';
import { DMPLogger } from '../../EventTrack/DMPLogger';

//星河小程序内部嵌入的webview
@Component
export struct EmbedWebView {
  @Prop
  data: WebViewParams;
  @Prop
  parentWebViewId: number
  @Prop
  webViewId: number
  @State
  mode: CacheMode = CacheMode.Online;
  pageParams: DMPMap = new DMPMap()
  @Prop
  appIndex: number;
  private webViewProxy: DMPWebViewProxy = new DMPWebViewProxy(this.webViewId, this.appIndex);
  private webviewController =
    new DMPWebViewController(this.webViewId, DMPAppManager.sharedInstance().getApp(this.appIndex)!)

  aboutToAppear(): void {
    // aboutToAppear 发生在 build() 创建 Web 组件、webviewController 绑定组件之前——
    // 此时调用 controller 方法（如 accessBackward）会抛 BusinessError 17100001。这里只做
    // 不依赖 controller 绑定状态的账本登记；槽位易主后的镜像重采样挪到
    // onControllerAttached（build() 里），那是 controller 方法开始可用的最早时点
    const render = DMPAppManager.sharedInstance().getApp(this.appIndex)?.render;
    const controller = render?.getController(this.parentWebViewId)
    if (render && controller) {
      controller.subController = this.webviewController
      render.controllerMap.set(this.webViewId, controller)
    }
  }

  aboutToDisappear(): void {
    const app = DMPAppManager.sharedInstance().getApp(this.appIndex)
    app?.render?.controllerMap.delete(this.webViewId)
    // 只有当前占据 subController 槽位（= 标题栏点击回退的目标）的实例卸载时才清镜像，
    // 避免非活跃实例的卸载误清活跃实例的历史状态
    if (this.isActiveEmbedController()) {
      const record = app?.navigatorManager.getPageRecordById(this.parentWebViewId)
      if (record && record.embeddedCanGoBack) {
        record.embeddedCanGoBack = false
      }
    }
  }

  // 把嵌入 web-view 的可回退状态镜像到宿主页 pageRecord（@Observed 一层属性，
  // 赋值触发标题栏重建），仅在状态变化时写入避免无谓重建。宿主页的嵌入回退
  // 目标是单槽位 subController，镜像只接受该槽位当前持有者的写入——多个嵌入
  // 实例并存时，非活跃实例的导航/卸载事件不会污染镜像
  private syncEmbeddedHistoryState(): void {
    if (!this.isActiveEmbedController()) {
      return
    }
    const record =
      DMPAppManager.sharedInstance().getApp(this.appIndex)?.navigatorManager.getPageRecordById(this.parentWebViewId)
    if (!record) {
      return
    }
    const canGoBack = this.webviewController.accessBackward()
    if (record.embeddedCanGoBack !== canGoBack) {
      record.embeddedCanGoBack = canGoBack
    }
  }

  private isActiveEmbedController(): boolean {
    const parentController =
      DMPAppManager.sharedInstance().getApp(this.appIndex)?.getWebController(this.parentWebViewId)
    return parentController?.subController === this.webviewController
  }

  build() {
    Column() {

      Web({
        src: this.data?.attributes?.src,
        controller: this.webviewController
      })
        .fileAccess(true)
        .zoomAccess(false)
        .verticalScrollBarAccess(false)
        .domStorageAccess(true)
        .geolocationAccess(true)
        .javaScriptProxy({
          object: this.webViewProxy,
          name: "DiminaRenderBridge",
          methodList: ["invoke"],
          asyncMethodList: ["publish"],
          controller: this.webviewController
        })
        .onControllerAttached(() => {
          // controller 成功绑定到 Web 组件、其方法开始可用的最早时点（早于
          // onPageBegin/onPageEnd）。新活跃实例通常尚无历史，这里立刻把上一任槽位持有者
          // 留下的镜像值纠正过来，不等首个 onPageEnd
          this.syncEmbeddedHistoryState()
        })
        .onPageBegin(() => {
          this.webviewController.initConfig() // 设置ua
        })
        .onPageEnd(() => {
          this.syncEmbeddedHistoryState()
          const script = this.data.attributes?.javascript;
          const attrs = this.data.attributes?.attrs;
          const moduleId = this.data.attributes?.moduleId;

          // 给webview注入webviewId，供jssdk使用
          this.webviewController.runJavaScript(`
            window.embed_webviewId = ${this.webViewId};
            window.embed_webview_data = {
              moduleId: '${moduleId}',
              attrs: ${JSON.stringify(attrs)},
              parentWebViewId: ${this.parentWebViewId}
            };
          `);

          if (script != null) {
            this.webviewController.runJavaScript(script)
          }
        })
        .onTitleReceive((title) => {
          if (title.title) {
            const navigator: DMPNavigatorManager =
              DMPAppManager.sharedInstance().getApp(this.appIndex)?.navigatorManager!
            if (navigator) {
              const originNavStyle = navigator.getPageRecordById(this.parentWebViewId)?.pageStyle?.navStyle
              if (originNavStyle) {
                const navStyle = DMPMap.createFromDMPMap(originNavStyle)
                navStyle.set('navigationBarTitleText', DMPStringUtils.truncateString(title.title))
                navigator.getPageRecordById(this.parentWebViewId)!.pageStyle =
                  new DMPPageStyle(navStyle ?? new DMPMap(), this.appIndex)
              }
            }
          }
        })
        .cacheMode(this.mode)
        .onErrorReceive((event) => {
          if (event != null) {
            DMPLogger.e('', "webview load error:" + event.error.getErrorInfo().toString())
          }
        })

    }.width('100%').height('100%')
  }

  goBack() {
    const navigator: DMPNavigatorDelegate | undefined =
      DMPAppManager.sharedInstance().getApp(this.appIndex)?.navigatorManager?.getCurNavigator()
    navigator && navigator.pop()
  }
}
