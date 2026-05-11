import { DMPTabBar } from '../Components/DMPTabBar'
import { DMPTabBarConfig } from '../Bundle/Model/DMPBundleAppConfigNext'
import { DMPPageContainer } from '../DPages/DMPPageContainer'
import { DMPApp } from '../DApp/DMPApp'
import { DMPAppManager } from '../DApp/DMPAppManager'
import { DMPLogger } from '../EventTrack/DMPLogger'
import { Tags } from '../EventTrack/Tags'
import { DMPPageRecord } from '../Navigator/DMPPageRecord'

/**
 * TabBar container that manages multiple tab pages simultaneously
 * Similar to iOS DMPTabBarContainerViewController and Android multi-WebView approach
 */
@Component
export struct DMPTabBarContainerView {
  @Prop appIndex: number
  private app: DMPApp | undefined = undefined
  private tabBarConfig: DMPTabBarConfig | undefined = undefined
  @State selectedIndex: number = 0
  // Use Map to track loaded tab pages (index -> DMPPageRecord)
  @State tabPageRecords: Map<number, DMPPageRecord> = new Map()

  aboutToDisappear() {
    // 容器被销毁时清掉 tab 跟踪标记，避免 reLaunch / 退出后残留导致 currentWebViewId 错指
    this.app?.navigatorManager?.clearCurrentTabWebViewId()
  }

  /**
   * 将沙盒绝对路径包成 file:// URI。
   * ArkUI Image 如果直接拿到 `/data/...` 这种裸绝对路径，会按 HAP rawfile 走，
   * 报 "GetAsset failed"；包成 `file:///data/...` 才会走文件系统。
   */
  private toFileUri(absolutePath: string): string {
    if (absolutePath.startsWith('file://')) {
      return absolutePath
    }
    if (absolutePath.startsWith('/')) {
      return `file://${absolutePath}`
    }
    return `file:///${absolutePath}`
  }

  /**
   * 将一个 tab 图标路径解析为 ArkUI Image 可加载的绝对 file:// URI。
   * 规则：
   *   - 空 / 协议化 URL（http / https / file / data）→ 原样返回
   *   - /<appId>/...（编译器输出，对应 sandbox 中相同子路径）→ ${jsAppDir} 拼接后包成 file://
   *   - /  开头但不属于上面情况 → 包成 file://（视为绝对文件系统路径）
   *   - 其它（相对路径，老配置或手填）→ 拼到 ${jsAppDir}/main/ 下并包成 file://
   */
  private resolveBundleAssetPath(rawPath: string | undefined): string | undefined {
    if (!rawPath || rawPath.length === 0) {
      return rawPath
    }
    if (rawPath.startsWith('http://') || rawPath.startsWith('https://')
      || rawPath.startsWith('file://') || rawPath.startsWith('data:')) {
      return rawPath
    }
    if (!this.app) {
      return rawPath
    }
    const appId = this.app.bundleManager.getBundleInfo().appId
    const jsAppDir = this.app.bundleManager.getCurrentJSAppDir()
    const appIdPrefix = `/${appId}/`
    if (rawPath.startsWith(appIdPrefix)) {
      return this.toFileUri(`${jsAppDir}/${rawPath.substring(appIdPrefix.length)}`)
    }
    if (rawPath.startsWith('/')) {
      return this.toFileUri(rawPath)
    }
    return this.toFileUri(`${jsAppDir}/main/${rawPath}`)
  }

  /**
   * 把 tabBar.list 中每个 item 的 iconPath / selectedIconPath 解析为可加载路径。
   * 解析后直接写回 item（resolveBundleAssetPath 幂等，多次调用不会重复添加前缀）。
   */
  private resolveTabBarIconPaths() {
    if (!this.tabBarConfig || !this.tabBarConfig.list) {
      return
    }
    for (const item of this.tabBarConfig.list) {
      const resolvedIcon = this.resolveBundleAssetPath(item.iconPath)
      if (resolvedIcon !== item.iconPath) {
        item.iconPath = resolvedIcon
      }
      const resolvedSelected = this.resolveBundleAssetPath(item.selectedIconPath)
      if (resolvedSelected !== item.selectedIconPath) {
        item.selectedIconPath = resolvedSelected
      }
    }
    DMPLogger.d(Tags.TABBAR, `Resolved tabBar icon paths under ${this.app?.bundleManager?.getCurrentJSAppDir()}`)
  }

  aboutToAppear() {
    // Get app and tabBar config
    this.app = DMPAppManager.sharedInstance().getApp(this.appIndex)
    if (!this.app) {
      DMPLogger.e(Tags.TABBAR, 'App not found in TabBarContainer')
      return
    }

    this.tabBarConfig = this.app.bundleManager.getJsAppModuleConfig()?.tabBar
    if (!this.tabBarConfig || !this.tabBarConfig.list) {
      DMPLogger.e(Tags.TABBAR, 'TabBar config not found')
      return
    }

    // 把 list 中的 iconPath / selectedIconPath 解析为沙盒中真实的 static 文件绝对路径
    // 编译器输出形如 /<appId>/main/static/<prefix>_<file>，需要换成 ${jsAppDir}/main/static/...
    // 才能被 ArkUI Image 加载
    this.resolveTabBarIconPaths()

    // Determine initial tab index
    this.determineInitialTabIndex()

    // Load only the initial tab page (lazy load others on demand)
    this.loadTabPageAtIndex(this.selectedIndex)

    const initialPageRecord = this.tabPageRecords.get(this.selectedIndex)
    if (initialPageRecord) {
      this.app.navigatorManager.setCurrentTabWebViewId(initialPageRecord.webViewId)
    }

    // Listen to switchTab events from JS API
    getContext(this).eventHub.on('tabbar_switch_webview', (data: ESObject) => {
      const targetPath: string = data['pagePath']
      // 由 DMPNavigator.switchTab 计算：旧 tab 是否之前就是可见页面
      // (栈顶若是 navigateTo 推入页面，旧 tab 已被 onHide 过，不应再触发)
      const wasPrevTabVisible: boolean = data['wasPrevTabVisible'] !== false
      DMPLogger.d(Tags.TABBAR, `Received tabbar_switch_webview event for path: ${targetPath}, wasPrevTabVisible=${wasPrevTabVisible}`)

      // Find the index of the target tab
      if (this.tabBarConfig) {
        const index = this.tabBarConfig.list.findIndex(item => item.pagePath === targetPath)
        if (index >= 0) {
          DMPLogger.d(Tags.TABBAR, `Switching to tab index: ${index}`)
          this.handleTabSelected(index, wasPrevTabVisible)
        } else {
          DMPLogger.e(Tags.TABBAR, `Tab path not found in config: ${targetPath}`)
        }
      }
    })

    DMPLogger.d(Tags.TABBAR, `TabBarContainer initialized. Initial tab loaded: ${this.selectedIndex}`)
  }

  /**
   * Determine which tab should be initially selected
   */
  private determineInitialTabIndex() {
    if (!this.tabBarConfig || !this.app) return

    const currentPath = this.app.navigatorManager.getCurNavigator()?.getNavigator().getCurrentPagePath()
    if (currentPath) {
      const index = this.tabBarConfig.list.findIndex(item => item.pagePath === currentPath)
      if (index >= 0) {
        this.selectedIndex = index
        DMPLogger.d(Tags.TABBAR, `Initial tab index set to: ${index}`)
        return
      }
    }

    // Default to first tab
    this.selectedIndex = 0
    DMPLogger.d(Tags.TABBAR, `Initial tab index defaulting to: 0`)
  }

  /**
   * Load a tab page at the specified index (lazy loading)
   * Only creates the page record if it hasn't been loaded yet
   * Note: Tab pages are NOT added to navigator stack - they're managed here
   */
  private loadTabPageAtIndex(index: number) {
    if (!this.tabBarConfig || !this.app || index >= this.tabBarConfig.list.length) {
      DMPLogger.e(Tags.TABBAR, `Invalid tab index: ${index}`)
      return
    }

    // Check if already loaded in our local map
    if (this.tabPageRecords.has(index)) {
      DMPLogger.d(Tags.TABBAR, `Tab ${index} already loaded, skipping`)
      return
    }

    const navigator = this.app.navigatorManager.getCurNavigator()
    if (!navigator) {
      DMPLogger.e(Tags.TABBAR, 'Navigator not found')
      return
    }

    const pagePath = this.tabBarConfig.list[index].pagePath

    // Reuse existing page record from navigator stack (initial tab already created by preLoadPage)
    const existingRecord = navigator.getNavigator().findPageRecordByPath(pagePath)
    if (existingRecord) {
      this.tabPageRecords.set(index, existingRecord)
      DMPLogger.d(Tags.TABBAR, `Reused existing page record for tab ${index}: ${pagePath}, webViewId: ${existingRecord.webViewId}`)
      return
    }

    // Create new page record for this tab (not added to stack)
    DMPLogger.d(Tags.TABBAR, `Creating new page record for tab ${index}: ${pagePath}`)
    const pageRecord = navigator.getNavigator().createPageRecordForTab(pagePath)

    // Store in map (tab pages are managed here, not in navigator stack)
    this.tabPageRecords.set(index, pageRecord)
    DMPLogger.d(Tags.TABBAR, `Tab ${index} loaded. Total loaded tabs: ${this.tabPageRecords.size}`)
  }

  /**
   * Handle tab selection
   *
   * @param index 目标 tab 索引
   * @param wasPrevTabVisible 旧 tab 是否之前就是可见页面：
   *   - true（默认）：用户在 tab 页面上点击切换 / 初始化场景
   *   - false：JS switchTab 来自 navigateTo 推入页面的上方，旧 tab 已 onHide 过
   */
  private handleTabSelected(index: number, wasPrevTabVisible: boolean = true) {
    if (!this.tabBarConfig || index >= this.tabBarConfig.list.length) {
      return
    }

    const targetPath = this.tabBarConfig.list[index].pagePath
    DMPLogger.d(Tags.TABBAR, `Tab selected: ${index}, path: ${targetPath}, wasPrevTabVisible=${wasPrevTabVisible}`)

    // Get previous tab's webViewId (if exists)
    const previousWebViewId = this.tabPageRecords.has(this.selectedIndex)
      ? this.tabPageRecords.get(this.selectedIndex)!.webViewId
      : -1

    // Lazy load the tab page if not already loaded
    this.loadTabPageAtIndex(index)

    // Get current tab's webViewId (must exist after loading)
    const currentPageRecord = this.tabPageRecords.get(index)
    if (!currentPageRecord) {
      DMPLogger.e(Tags.TABBAR, `Failed to get page record for tab ${index}`)
      return
    }

    // Update lifecycle: hide previous tab (if it was visible), show current tab
    if (this.app) {
      // 在触发 onHide/onShow 之前先更新 currentTabWebViewId，
      // 避免 lifecycle 内部再次访问 currentWebViewId 时拿到旧值
      this.app.navigatorManager.setCurrentTabWebViewId(currentPageRecord.webViewId)
      const navigator = this.app.navigatorManager.getCurNavigator()
      if (navigator) {
        navigator.getNavigator().updateTabBarSelection(previousWebViewId, currentPageRecord.webViewId, wasPrevTabVisible)
      }
    }

    // Update selected index (this will trigger UI update via @State)
    this.selectedIndex = index
  }

  build() {
    Column() {
      // Stack of loaded tab pages (only selected one is visible)
      Stack() {
        // Iterate through the loaded tab pages in the Map
        ForEach(Array.from(this.tabPageRecords.entries()), (entry: [number, DMPPageRecord]) => {
          DMPPageContainer({
            appIndex: this.appIndex,
            webViewId: entry[1].webViewId,
            hideTabBar: true  // Hide TabBar in individual pages (container shows it)
          })
            .visibility(entry[0] === this.selectedIndex ? Visibility.Visible : Visibility.None)
            .zIndex(entry[0] === this.selectedIndex ? 1 : 0)
        }, (entry: [number, DMPPageRecord]) => `tab_${entry[0]}_${entry[1].webViewId}`)
      }
      .layoutWeight(1)
      .width('100%')

      // TabBar at container level
      if (this.tabBarConfig) {
        DMPTabBar({
          selectedIndex: this.selectedIndex,
          tabBarConfig: this.tabBarConfig,
          onTabSelected: (index: number) => {
            this.handleTabSelected(index)
          }
        })
      }
    }
    .width('100%')
    .height('100%')
  }
}
