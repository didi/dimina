import { DMPApp } from '../DApp/DMPApp'
import { DMPAppManager } from '../DApp/DMPAppManager'
import { WebViewDefaultId } from '../DApp/config/DMPLaunchConfig'
import { DMPLogger } from '../EventTrack/DMPLogger'
import { Tags } from '../EventTrack/Tags'
import { DMPWebViewController } from './DMPWebViewController'
import { DMPPageRecord } from '../Navigator/DMPPageRecord'
import { DMPIdProvider } from '../Navigator/DMPIdProvider'
import { DMPMap } from '../Utils/DMPMap'
import { DMPPageStyle } from '../DPages/DMPPageStyle'
import { DMPWebViewNodeController, NodeControllerWrapper } from './DMPWebViewNodeController'


export class DMPWebViewCachePool {
  private app: DMPApp
  private runtimeGeneration: number
  //通用缓存池
  private generalCachePool: Array<DMPWebViewNodeController> = []
  //轻量缓存池
  private lightCachePool: Map<string, NodeControllerWrapper> = new Map()
  //全量缓存池
  private fullCachePool: Map<string, NodeControllerWrapper> = new Map()
  //初始化缓存池大小
  private cacheCount: number = 1;
  //增长数量
  private increaseCount: number = 2;

  constructor(app: DMPApp) {
    this.app = app
    this.runtimeGeneration = app.runtimeGeneration
  }

  init() {
    for (let i = 0; i < this.cacheCount; i++) {
      this.preLoadWebView();
    }
  }

  getWebViewNodeController(pagePath: string, query: DMPMap): DMPWebViewNodeController {
    DMPLogger.d(Tags.PRE_LOAD, '获取缓存池webView pagePath:' + pagePath + " query:" + query.toStr())
    if (this.isHitFullCache(pagePath, query)) {
      DMPLogger.d(Tags.PRE_LOAD, '命中全量缓存')
      const data = this.fullCachePool.get(pagePath)?.webViewNodeController!
      this.fullCachePool.delete(pagePath)
      return data;
    }
    if (this.generalCachePool.length < 1) {
      DMPLogger.d(Tags.PRE_LOAD, '缓存池为小于2,开始新的预加载')
      this.increaseCache()
    }
    return this.generalCachePool.pop()!;
  }

  private isHitFullCache(pagePath: string, query: DMPMap): boolean {
    if (this.fullCachePool.size > 0 && this.fullCachePool.has(pagePath)) {
      const cacheQuery = this.fullCachePool.get(pagePath)?.query;
      if (cacheQuery && (cacheQuery.toStr() == query.toStr())) {
        return true;
      }
    }
    return false;
  }

  increaseCache() {
    this.preLoadWebView();
    //避免一次性新增太多阻塞UI
    setTimeout(() => {
      if (this.generalCachePool.length < 1) {
        if (this.app && this.runtimeGeneration === this.app.runtimeGeneration &&
          DMPAppManager.sharedInstance().getApp(this.app.appIndex) === this.app) {
          for (let i = 0; i < this.increaseCount - 1; i++) {
            this.preLoadWebView();
          }
        } else {
          DMPLogger.e(Tags.PRE_LOAD, "app is destroy")
        }
      }
    }, 1500)

  }

  private preLoadWebView() {
    DMPLogger.d(Tags.PRE_LOAD, '准备预加载一个webView')
    const webViewId = DMPIdProvider.generateWebViewId();
    const controller: DMPWebViewController = new DMPWebViewController(webViewId, this.app)
    this.app.render.setController(webViewId, controller)
    const webViewNodeController = new DMPWebViewNodeController(webViewId, this.app);
    webViewNodeController.initWeb(DMPApp.getWindowStage().getMainWindowSync().getUIContext(), webViewId,
      this.app.appIndex)
    this.generalCachePool.push(webViewNodeController)
    DMPLogger.d(Tags.PRE_LOAD, '预加载webView实例已创建 webViewId:' + webViewId)
  }

  preLoadFullWebView(pagePath: string, query: DMPMap) {
    DMPLogger.d(Tags.PRE_LOAD, '准备预加载一个完整webview页面')
    const webViewId = DMPIdProvider.generateWebViewId();
    const controller: DMPWebViewController = new DMPWebViewController(webViewId, this.app)
    this.app.render.setController(webViewId, controller)
    const webViewNodeController = new DMPWebViewNodeController(webViewId, this.app);
    webViewNodeController.initWeb(DMPApp.getWindowStage().getMainWindowSync().getUIContext(), webViewId,
      this.app.appIndex)
    this.fullCachePool.set(pagePath, new NodeControllerWrapper(pagePath, query, webViewNodeController))
    //创建缓存记录
    const navStyle = this.app.bundleManager.getJsAppModuleConfig()!.getPageConfigNext(pagePath)
    const pageRecord =
      new DMPPageRecord(webViewId, WebViewDefaultId.InitId, pagePath, this.app.appIndex, webViewNodeController)
    pageRecord.params = query
    pageRecord.pageStyle = new DMPPageStyle(navStyle ?? new DMPMap(), this.app.appIndex)
    this.app.navigatorManager?.pushGlobalPreLoadPageRecord(pageRecord)

    //加载资源
    webViewNodeController.loadResource(pagePath)
    DMPLogger.d(Tags.PRE_LOAD, '预加载一个完整webview实例已创建 webViewId:' + webViewId)
  }
}
