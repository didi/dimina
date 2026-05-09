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

    // Determine initial tab index
    this.determineInitialTabIndex()

    // Load only the initial tab page (lazy load others on demand)
    this.loadTabPageAtIndex(this.selectedIndex)

    // Trigger onShow for initial tab (no previous tab, so previousWebViewId = -1)
    const initialPageRecord = this.tabPageRecords.get(this.selectedIndex)
    if (initialPageRecord) {
      const navigator = this.app.navigatorManager.getCurNavigator()
      if (navigator) {
        navigator.getNavigator().updateTabBarSelection(-1, initialPageRecord.webViewId)
      }
    }

    // Listen to switchTab events from JS API
    getContext(this).eventHub.on('tabbar_switch_webview', (data: ESObject) => {
      const targetPath: string = data['pagePath']
      DMPLogger.d(Tags.TABBAR, `Received tabbar_switch_webview event for path: ${targetPath}`)

      // Find the index of the target tab
      if (this.tabBarConfig) {
        const index = this.tabBarConfig.list.findIndex(item => item.pagePath === targetPath)
        if (index >= 0) {
          DMPLogger.d(Tags.TABBAR, `Switching to tab index: ${index}`)
          this.handleTabSelected(index)
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
   */
  private handleTabSelected(index: number) {
    if (!this.tabBarConfig || index >= this.tabBarConfig.list.length) {
      return
    }

    const targetPath = this.tabBarConfig.list[index].pagePath
    DMPLogger.d(Tags.TABBAR, `Tab selected: ${index}, path: ${targetPath}`)

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

    // Update lifecycle: hide previous tab, show current tab
    if (this.app) {
      const navigator = this.app.navigatorManager.getCurNavigator()
      if (navigator) {
        navigator.getNavigator().updateTabBarSelection(previousWebViewId, currentPageRecord.webViewId)
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
