import { BusinessError } from '@ohos.base';
import { DMPApp } from '../DApp/DMPApp';
import { DMPPageRecord as DMPPageRecord } from './DMPPageRecord';
import { DMPLaunchConfig, DMPOpenType } from '../DApp/config/DMPLaunchConfig';
import { DMPLogger } from '../EventTrack/DMPLogger';
import { Tags } from '../EventTrack/Tags';
import { DMPPageStyle } from '../DPages/DMPPageStyle';
import { DMPMap } from '../Utils/DMPMap';
import { DMPPageLifecycle } from '../DPages/DMPPageLifecycle';
import { DMPBridgeCallback, DMPBridgeCallbackType, DMPTSUtil } from '../Bridges/DMPTSUtil';
import { promptAction } from '@kit.ArkUI';
import { DMPStack } from '../Utils/DMPStack';
import { DRouter } from './DRouter';
import { DMPPage } from '../DPages/DMPPage';


export class DMPNavigator {
  private _stacks: DMPStack<DMPPageRecord> = new DMPStack();

  public get stacks(): DMPStack<DMPPageRecord> {
    return this._stacks;
  }

  private app: DMPApp
  private pageLifecycle: DMPPageLifecycle

  constructor(app: DMPApp) {
    this.app = app;
    this.pageLifecycle = new DMPPageLifecycle(app)
  }

  public isContainsWebViewId(webViewId: number): boolean {
    let isContains = false;
    for (let record of this._stacks.data) {
      if (record.webViewId == webViewId) {
        isContains = true;
        break
      }
    }
    return isContains;
  }

  pageCount(): number {
    return this._stacks.size()
  }


  async navigateTo(stackId: number, params: DMPMap) {
    this.app.container.isNavigating = true;
    DMPLogger.d(Tags.NAVIGATOR, 'navigateTo')
    const pagePath: string = params.get('pagePath')

    const appConfig = this.app.bundleManager.getJsAppModuleConfig()
    const tabBarPagePaths = appConfig?.getTabBarPagePaths() ?? new Set<string>()
    if (tabBarPagePaths.has(pagePath)) {
      const errorMsg = `navigateTo: fail can not navigateTo a tabbar page: ${pagePath}`
      DMPLogger.e(Tags.NAVIGATOR, errorMsg)
      promptAction.showToast({ message: errorMsg, duration: 2000, alignment: Alignment.Center })
      this.app.container.isNavigating = false
      // 抛错，桥层 .catch 后调用 wx.navigateTo 的 fail 回调
      throw new Error(errorMsg)
    }

    const callback: DMPBridgeCallback = (_: DMPMap, cbType: DMPBridgeCallbackType) => {
      if (cbType == DMPBridgeCallbackType.Success) {
        this.openPage(stackId, pagePath, params)
      }
      if (cbType == DMPBridgeCallbackType.Fail) {
        promptAction.showToast({ message: '子包加载失败', duration: 1, alignment: Alignment.Center })
      }
      DMPLogger.d(Tags.NAVIGATOR, 'loadSubPackage callback result=' + cbType)
    }
    this.loadSubPackage(pagePath, callback)

  }

  async launch(stackId: number, launchConfig: DMPLaunchConfig) {
    DMPLogger.d(Tags.NAVIGATOR, 'launchPageNext')
    const params = new DMPMap()
    params.set('query', launchConfig?.query ?? new DMPMap())

    const pagePath: string = launchConfig.appEntryPath!
    const callback: DMPBridgeCallback = (_, cbType: DMPBridgeCallbackType) => {
      DMPLogger.d(Tags.LAUNCH, "loadSubPackage end");
      if (cbType == DMPBridgeCallbackType.Success) {
        this.openPage(stackId, pagePath, params, launchConfig.openType, launchConfig?.customLaunchPageCallBack)
      }
      if (cbType == DMPBridgeCallbackType.Fail) {
        promptAction.showToast({ message: '子包加载失败', duration: 1, alignment: Alignment.Center })
      }
      DMPLogger.d(Tags.NAVIGATOR, 'loadSubPackage callback result=' + cbType)
    }
    DMPLogger.d(Tags.LAUNCH, "loadSubPackage start");
    this.loadSubPackage(pagePath, callback)

  }

  async relaunchTo(params: DMPMap) {
    DMPLogger.d(Tags.NAVIGATOR, 'relaunchTo')
    const pagePath: string = params.get('pagePath')

    const callback: DMPBridgeCallback = (_, cbType: DMPBridgeCallbackType) => {
      if (cbType == DMPBridgeCallbackType.Success) {
        this.realReLaunchTo(pagePath, params)
      }
      if (cbType == DMPBridgeCallbackType.Fail) {
        promptAction.showToast({ message: '子包加载失败', duration: 1, alignment: Alignment.Center })
      }
      DMPLogger.d(Tags.NAVIGATOR, 'loadSubPackage callback result=' + cbType)
    }
    this.loadSubPackage(pagePath, callback)

  }


  private realReLaunchTo(pagePath: string, params: DMPMap) {
    const launchConfig = this.app.getLaunchConfig();
    if (launchConfig) {
      if (pagePath.startsWith('/') && pagePath.length > 1) {
        const realPagePath = pagePath.substring(1)
        launchConfig.appEntryPath = realPagePath
      } else {
        launchConfig.appEntryPath = pagePath
      }

      launchConfig.query = params.get('query')
    }
    this.app.reLaunch()

  }

  /**
   * 返回首页（导航栏 home 按钮的唯一路由入口），终态都是只剩首页：
   * 首页是 tab 页走 switchTab（保留其它 tab 状态并露出 tabBar，自带清非 tab 栈）；
   * 首页非 tab 且当前是栈底，redirectTo 原地替换；非栈底（homeButton: true
   * 的内页）redirect 只会替换栈顶、栈底仍在，须 relaunch 清整栈
   */
  async navigateHome(stackId: number) {
    const appConfig = this.app.bundleManager.getJsAppModuleConfig()
    const entryPagePath = appConfig?.entryPagePath
    if (!appConfig || !entryPagePath) {
      return
    }
    const routerParam = new DMPMap({ query: new DMPMap(), pagePath: entryPagePath })
    if (appConfig.isTabBarPage(entryPagePath)) {
      // 冷启动直达非 tab 内页时，栈内没有任何 tabBar 页，switchTab 清栈后无处可切
      // （会抛 no tabBar context）；此时没有已加载的 tab 状态可保留，清栈重启到
      // tab 首页与 switchTab 终态等价
      const tabBarPagePaths = appConfig.getTabBarPagePaths()
      let hasTabInStack = false
      for (let record of this._stacks.data) {
        if (tabBarPagePaths.has(record.pagePath)) {
          hasTabInStack = true
          break
        }
      }
      if (hasTabInStack) {
        await this.switchTab(routerParam)
      } else {
        await this.relaunchTo(routerParam)
      }
    } else if (this.pageCount() <= 1) {
      await this.redirectTo(stackId, routerParam)
    } else {
      await this.relaunchTo(routerParam)
    }
  }

  async redirectTo(stackId: number, params: DMPMap) {
    DMPLogger.d(Tags.NAVIGATOR, 'redirectTo')
    const pagePath: string = params.get('pagePath')

    // 微信规范：redirectTo 不允许跳到 tabBar 页面
    const appConfig = this.app.bundleManager.getJsAppModuleConfig()
    const tabBarPagePaths = appConfig?.getTabBarPagePaths() ?? new Set<string>()
    if (tabBarPagePaths.has(pagePath)) {
      const errorMsg = `redirectTo:fail can not redirectTo a tabbar page: ${pagePath}`
      DMPLogger.e(Tags.NAVIGATOR, errorMsg)
      promptAction.showToast({ message: errorMsg, duration: 2000, alignment: Alignment.Center })
      throw new Error(errorMsg)
    }

    const callback: DMPBridgeCallback = (_, cbType: DMPBridgeCallbackType) => {
      if (cbType == DMPBridgeCallbackType.Success) {
        this.realRedirectTo(stackId, pagePath, params)
      }
      if (cbType == DMPBridgeCallbackType.Fail) {
        promptAction.showToast({ message: '子包加载失败', duration: 1, alignment: Alignment.Center })
      }
      DMPLogger.d(Tags.NAVIGATOR, 'loadSubPackage callback result=' + cbType)
    }
    this.loadSubPackage(pagePath, callback)
  }


  private realRedirectTo(stackId: number, pagePath: string, params: DMPMap) {
    DMPLogger.i(Tags.REDIRECT, params.toStr())
    this.pageLifecycle.onUnload(this.app.currentWebViewId)
    this.popPageRecord()

    const navStyle = this.app.bundleManager.getJsAppModuleConfig()!.getPageConfigNext(pagePath)
    const webViewNodeController = this.app.webViewCachePool.getWebViewNodeController(pagePath, params)
    const newWebViewId = webViewNodeController.webViewId
    let currentPageRecord = this.app.navigatorManager.getTopPageRecord();
    let pageRecord =
      new DMPPageRecord(newWebViewId, currentPageRecord?.webViewId ?? -1, pagePath, this.app.appIndex,
        webViewNodeController)
    pageRecord.params = params
    pageRecord.pageStyle = new DMPPageStyle(navStyle ?? new DMPMap(), this.app.appIndex)
    this.pushPageRecordStack(pageRecord)
    //加载资源,必须要在pageRecord 之后
    webViewNodeController.loadResource(pagePath)
    try {
      DRouter.getInstance()
        .build('onetravel://dimina/page')
        .putExtra("appIndex", this.app.appIndex)
        .putExtra("webViewId", pageRecord.webViewId)
        .putExtra("stackId", stackId)
        .setNavMode(DMPOpenType.Insert)
        .start()
    } catch (err) {
      DMPLogger.e(Tags.NAVIGATOR, `msg: ${(err as BusinessError).message}`)
    }

    this.pageLifecycle.onShow(newWebViewId)
  }

  async pop(delta: number = 1, animated: boolean = true, canDestroy = true, isReLaunch = false) {
    DMPLogger.i(Tags.NAVIGATOR, 'pop')
    try {
      if (this.app.container.isNavigating) {
        return
      }
      //处理多栈
      if (delta > this._stacks.size()) {
        delta = this._stacks.size();
      }
      for (let i = 0; i < delta; i++) {
        this.pageLifecycle.onUnload(this.app.currentWebViewId)
        // 弹路由前先看账本顶部记录是否真的占了 NavPathStack 槽位（见
        // DMPPageRecord.shouldPopRouter）；popPageRecord() 会立刻把它从账本弹掉，须先取
        if (DMPPageRecord.shouldPopRouter(this._stacks.peek()?.ownsRouterEntry)) {
          DRouter.getInstance().pop(animated)
        }
        this.popPageRecord()
      }
      // ReLaunch 补弹分支：与上面的 shouldPopRouter 判据是两件独立的事，不要合并。
      // DApp.reLaunchCurrentStack/reLaunchRootStack 在被清空的 navigator 本身以
      // customLaunchPageCallBack/openType=Insert 启动时，会把传入的 delta 预先 -1，
      // 让上面的循环少处理这最后一条记录；这里只把它从账本弹掉，不调用 DRouter.pop()——
      // 该记录要么从未进入 NavPathStack（customLaunchPageCallBack），要么是靠 replace
      // 复用下层已有槽位（Insert），两种情况都不需要（也不能）在此额外弹一次路由帧
      if (isReLaunch && this._stacks.size() > 0) {
        this.pageLifecycle.onUnload(this.app.currentWebViewId)
        this.popPageRecord()
      }
      //销毁这个navigator
      if (this._stacks.size() < 1) {
        this.app.navigatorManager.popNavigator()
      }
      this.app.navigatorManager.notifyPopListener()
      if (canDestroy && !this.app.appConfig.isKeepAlive) {
        //销毁app
        if (this.app.navigatorManager.isEmpty()) {
          this.app.navigatorManager.clear()
          this.app.destroyEngine()
          this.app.destroyApp()
          return
        }
      }
      // 用 getActivePageRecord：tab 模式下从 navigateTo 推入页面退回时，
      // 应当 onShow 真实的当前 tab，而非栈底初始 tab
      let currentPageRecord = this.app.navigatorManager.getActivePageRecord();
      this.pageLifecycle.onShow(currentPageRecord?.webViewId ?? -1)

    } catch (err) {
      DMPLogger.e(Tags.BRIDGE, `msg: ${(err as BusinessError).message}`)
    }
  }

  closeAllPages(animated: boolean = false) {
    const pageCount = this._stacks.size()
    for (let i = 0; i < pageCount; i++) {
      this.pageLifecycle.onUnload(this.app.currentWebViewId)
      // 同 pop()：customLaunchPageCallBack 挂载的记录从未占用 NavPathStack 槽位，
      // 无条件 DRouter.pop() 会误弹宿主自己挂载的页面
      if (DMPPageRecord.shouldPopRouter(this._stacks.peek()?.ownsRouterEntry)) {
        DRouter.getInstance().pop(animated)
      }
      this.popPageRecord()
    }
  }

  async navigateBack(delta: number, animated: boolean = true, canDestroy = true, isReLaunch = false) {
    DMPLogger.d(Tags.NAVIGATOR, 'navigateBack')
    this.pop(delta, animated, canDestroy, isReLaunch)
  }

  /**
   * Switch to a TabBar page
   * Simplified logic that works with DMPTabBarContainerView's lazy loading:
   * 1. Clear all non-tabBar pages from stack (leave only tab container)
   * 2. Emit event to let TabBarContainerView handle lazy loading and visibility switching
   *
   * 失败场景会抛错，由桥层 await 后转成 wx.switchTab 的 fail 回调：
   *   - 目标路径不在 app.tabBar.list 中
   *   - 当前没有可用的 TabBar 容器（清栈后栈为空）
   *   - eventHub.emit 抛错
   */
  async switchTab(params: DMPMap) {
    const pagePath: string = params.get('pagePath')
    DMPLogger.i(Tags.NAVIGATOR, `switchTab to: ${pagePath}`)

    // Get tabBar page paths
    const appConfig = this.app.bundleManager.getJsAppModuleConfig()
    const tabBarPagePaths = appConfig?.getTabBarPagePaths() ?? new Set<string>()

    // Validate that target path is actually a tab page
    if (!tabBarPagePaths.has(pagePath)) {
      DMPLogger.e(Tags.TABBAR, `Target path is not a tabBar page: ${pagePath}`)
      throw new Error(`switchTab:fail can not find target page "${pagePath}"`)
    }

    // 判断之前可见的页面是不是 tab：
    //   - 栈高 === 1 + 栈顶是 tab → 用户当前就在 tab 上 → 切换时需要 onHide 旧 tab
    //   - 栈高 > 1（tab 之上有 navigateTo 推入的页面）→ 旧 tab 早在 navigateTo 时已 onHide，
    //     此时只需要给上方非 tab 页面发 onUnload，**不要**重复 onHide 旧 tab
    // 这个判断必须在 pop 循环之前算，pop 之后栈结构已经变了
    const stackTopBeforePop = this._stacks.data[this._stacks.data.length - 1]
    const wasPrevTabVisible = this._stacks.data.length === 1
      && stackTopBeforePop !== undefined
      && tabBarPagePaths.has(stackTopBeforePop.pagePath)

    // Remove ALL non-tabBar pages from stack
    // Keep popping from top until we reach a tabBar page or empty stack
    let poppedCount = 0

    while (this._stacks.data.length > 0) {
      const topRecord = this._stacks.data[this._stacks.data.length - 1]

      // If top is a tabBar page, stop
      if (tabBarPagePaths.has(topRecord.pagePath)) {
        DMPLogger.d(Tags.TABBAR, `Reached tabBar page: ${topRecord.pagePath}, stopping pop`)
        break
      }

      // Pop non-tabBar page
      DMPLogger.d(Tags.TABBAR, `Popping non-tabBar page: ${topRecord.pagePath}`)

      // Unload lifecycle（非 tab 页面是真正销毁，应当走 onUnload 而不是 onHide）
      this.pageLifecycle.onUnload(topRecord.webViewId)

      // 弹路由前先看这条记录是否真的占了 NavPathStack 槽位（见 pop() 里同一判据的
      // 注释）；customLaunchPageCallBack 挂载的页面从未进入 DRouter，若在这里无脑
      // pop 会误弹共享单例栈里一条不相关的原生路由
      if (DMPPageRecord.shouldPopRouter(topRecord.ownsRouterEntry)) {
        DRouter.getInstance().pop(false) // animated = false，批量操作不做转场动画
      }

      // Remove from internal stack
      this._stacks.data.pop()
      this.app.navigatorManager.popGlobalPageRecord()

      poppedCount++
    }

    if (this._stacks.data.length === 0) {
      DMPLogger.e(Tags.TABBAR, `No tabBar page found in stack after clearing!`)
      throw new Error('switchTab:fail no tabBar context (stack empty after clearing)')
    }

    DMPLogger.d(Tags.TABBAR, `Cleared ${poppedCount} non-tabBar pages. Remaining stack size: ${this._stacks.data.length}, wasPrevTabVisible=${wasPrevTabVisible}`)

    // Emit event to TabBarContainerView to handle:
    // - Lazy loading the tab if not yet loaded
    // - Switching visibility to the target tab
    // - Calling updateTabBarSelection after loading is complete
    // wasPrevTabVisible: 告诉容器是否需要给旧 tab 发 onHide
    try {
      getContext(this.app).eventHub.emit('tabbar_switch_webview', {
        'pagePath': pagePath,
        'wasPrevTabVisible': wasPrevTabVisible
      })
      DMPLogger.d(Tags.TABBAR, `Emitted switch event for tab: ${pagePath}. TabBarContainerView will handle lazy loading.`)
    } catch (err) {
      DMPLogger.e(Tags.TABBAR, `Failed to emit tabbar switch event: ${err}`)
      throw new Error(`switchTab:fail event emit failed: ${(err as Error)?.message ?? err}`)
    }
  }

  //打开页面
  private openPage(stackId: number, pagePath: string, params: DMPMap,
    openType: DMPOpenType = DMPOpenType.NavigateTo,
    customLaunchPageCallBack?: (record: DMPPageRecord, path: String, stackId: number, isRelaunch?: boolean) => void) {
    DMPLogger.i(Tags.LAUNCH, "openPage");
    DMPLogger.d(Tags.LAUNCH, "notify page.onHide start");
    this.pageLifecycle.onHide(this.app.currentWebViewId)
    DMPLogger.d(Tags.LAUNCH, "notify page.onHide end");
    const pageRecord = this.preLoadPage(pagePath, params)
    pageRecord.ownsRouterEntry = DMPPageRecord.computeOwnsRouterEntry(!!customLaunchPageCallBack)

    try {
      if (customLaunchPageCallBack) {
        customLaunchPageCallBack(pageRecord, pagePath, stackId, this.app.getLaunchConfig()?.isRelaunch)
      } else {
        DRouter.getInstance()
          .build(DMPPage.ROUTE_NAME)
          .putExtra("appIndex", this.app.appIndex)
          .putExtra("webViewId", pageRecord.webViewId)
          .putExtra("stackId", stackId)
          .setNavMode(openType)
          .start()
      }
    } catch (err) {
      DMPLogger.e(Tags.NAVIGATOR, `msg: ${(err as BusinessError).message}`)
    }

    this.pageLifecycle.onShow(pageRecord.webViewId)

  }

  private popPageRecord() {
    this._stacks.pop()
    this.app.navigatorManager.popGlobalPageRecord()
  }

  private pushPageRecordStack(pageRecord: DMPPageRecord) {
    this._stacks.push(pageRecord)
    this.app.navigatorManager.pushGlobalPageRecord(pageRecord)
  }

  private loadSubPackage(pagePath: string, callback: DMPBridgeCallback) {
    const loadSubPackageOwner = this.app.appModuleManager.getModuleObjectByMethodName('loadSubPackage')
    const invokeParams = new DMPMap()
    const packageName: string = this.app?.bundleManager?.getJsAppModuleConfig()?.getRootPackage(pagePath)
    invokeParams.set('package', packageName)
    DMPTSUtil.invokeNativeMethod(loadSubPackageOwner, 'loadSubPackage', invokeParams, this.app.currentWebViewId,
      callback)
  }

  private preLoadPage(pagePath: string, params: DMPMap): DMPPageRecord {
    DMPLogger.i(Tags.LAUNCH, "preLoadPage start")
    //获取预加载webview记录
    const webViewNodeController = this.app.webViewCachePool.getWebViewNodeController(pagePath, params)
    const newWebViewId = webViewNodeController.webViewId

    //创建页面记录
    // 用 getActivePageRecord：navigateTo 自 tabB 时，新页面的 parentWebViewId
    // 应该是 tabB 而不是栈底的初始 tab
    const currentPageRecord = this.app.navigatorManager.getActivePageRecord();
    const pageRecord =
      new DMPPageRecord(newWebViewId, currentPageRecord?.webViewId ?? -1, pagePath, this.app.appIndex,
        webViewNodeController)
    pageRecord.params = params
    const navStyle = this.app.bundleManager.getJsAppModuleConfig()!.getPageConfigNext(pagePath)
    pageRecord.pageStyle = new DMPPageStyle(navStyle ?? new DMPMap(), this.app.appIndex)
    this.pushPageRecordStack(pageRecord)
    webViewNodeController.loadResource(pagePath)
    DMPLogger.i(Tags.LAUNCH, "preLoadPage end")
    return pageRecord;
  }

  /**
   * Find an existing page record by page path in the current navigator stack
   */
  public findPageRecordByPath(pagePath: string): DMPPageRecord | undefined {
    for (let record of this._stacks.data) {
      if (record.pagePath === pagePath) {
        return record
      }
    }
    return undefined
  }

  /**
   * Create a page record for a tab page without adding to navigator stack
   * Tab pages are managed by TabBarContainerView, not in navigator stack
   * This keeps DMPStack consistent with actual Router stack
   */
  public createPageRecordForTab(pagePath: string): DMPPageRecord {
    DMPLogger.i(Tags.TABBAR, `Creating page record for tab: ${pagePath}`)
    const params = new DMPMap()
    params.set('query', new DMPMap())

    const webViewNodeController = this.app.webViewCachePool.getWebViewNodeController(pagePath, params)
    const newWebViewId = webViewNodeController.webViewId

    const currentPageRecord = this.app.navigatorManager.getTopPageRecord()
    const pageRecord = new DMPPageRecord(
      newWebViewId,
      currentPageRecord?.webViewId ?? -1,
      pagePath,
      this.app.appIndex,
      webViewNodeController
    )
    pageRecord.params = params
    const navStyle = this.app.bundleManager.getJsAppModuleConfig()!.getPageConfigNext(pagePath)
    pageRecord.pageStyle = new DMPPageStyle(navStyle ?? new DMPMap(), this.app.appIndex)

    // IMPORTANT: Do NOT push to stack - tab pages are managed by TabBarContainerView
    // this.pushPageRecordStack(pageRecord)  // Removed to keep stack consistent

    // Register to global Map so getPageRecordById can find it
    this.app.navigatorManager.registerTabPageRecord(pageRecord)

    webViewNodeController.loadResource(pagePath)

    DMPLogger.i(Tags.TABBAR, `Created and registered tab page record: ${pagePath}, webViewId: ${newWebViewId}`)
    return pageRecord
  }

  /**
   * Handle tab lifecycle events (onHide/onShow) for tab switching
   * Since tab pages are NOT in navigator stack, this only manages lifecycle
   * Called from TabBarContainerView when switching tabs
   *
   * @param previousWebViewId 旧选中 tab 的 webViewId，<0 表示无（初始化场景）
   * @param currentWebViewId  新选中 tab 的 webViewId
   * @param triggerPrevHide   是否给旧 tab 发 onHide：
   *   - true：旧 tab 之前就是可见页面（用户在 tab 上点击切换 / 初始化）
   *   - false：旧 tab 不可见（navigateTo 推入页面在上方，旧 tab 早已 onHide 过），避免重复
   */
  public updateTabBarSelection(previousWebViewId: number, currentWebViewId: number, triggerPrevHide: boolean = true) {
    DMPLogger.i(Tags.TABBAR, `Switching tab lifecycle: ${previousWebViewId} -> ${currentWebViewId}, triggerPrevHide=${triggerPrevHide}`)

    // Trigger onHide for previous tab (if it was actually visible)
    if (triggerPrevHide && previousWebViewId >= 0) {
      this.pageLifecycle.onHide(previousWebViewId)
      DMPLogger.d(Tags.TABBAR, `onHide called for tab webViewId: ${previousWebViewId}`)
    }

    // Trigger onShow for current tab
    this.pageLifecycle.onShow(currentWebViewId)
    DMPLogger.d(Tags.TABBAR, `onShow called for tab webViewId: ${currentWebViewId}`)
  }

  /**
   * Get the current page path (for TabBar initialization)
   */
  public getCurrentPagePath(): string | undefined {
    const topRecord = this._stacks.data[this._stacks.data.length - 1]
    return topRecord?.pagePath
  }
}
