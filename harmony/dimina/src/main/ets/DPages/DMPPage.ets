import { DMPLogger } from '../EventTrack/DMPLogger'
import { DMPWindowUtil } from '../Utils/DMPWindowUtils'
import { Tags } from '../EventTrack/Tags'
import { DMPPageStyle } from './DMPPageStyle'
import { DMPPageRecord } from '../Navigator/DMPPageRecord'
import { DMPPageContainer } from './DMPPageContainer'
import { DMPTabBarContainerView } from '../Container/DMPTabBarContainerView'
import { DMPAppManager } from '../DApp/DMPAppManager'
import { DMPNavigatorDelegate } from '../Navigator/DMPNavigatorDelegate'
import { LaunchLoading } from './DMPLaunchLoading'
import { DMPApp } from '../DApp/DMPApp'
import { DMPColorUtils } from '../Utils/DMPColorUtils'

@Component
export struct DMPPage {
  @Prop uri: string
  @Prop param: Map<string, Object>
  appIndex = this.param.get('appIndex') as number
  webViewId = this.param.get('webViewId') as number
  stackId = this.param.get('stackId') as number
  private app?: DMPApp = DMPAppManager.sharedInstance().getApp(this.appIndex);
  @State pageRecord: DMPPageRecord =
    this.app?.navigatorManager?.getPageRecordById(this.webViewId)!;
  static ROUTE_NAME = "onetravel://dimina/page"
  @State
  private isLaunching: boolean = false
  private isTabBarContainer: boolean = false

  aboutToAppear(): void {
    DMPLogger.d(Tags.DMP_PAGE, `DMPPage aboutToAppear`)
    const navigator = this.app?.navigatorManager?.getCurNavigator();
    this.isLaunching = navigator?.getPageCount() == 1;

    // Check if this should be a TabBar container
    // Use container when: 1) it's the launch page, 2) app has tabBar config, 3) current page is a tabBar page
    if (this.isLaunching && this.app) {
      const appConfig = this.app.bundleManager.getJsAppModuleConfig()
      if (appConfig?.tabBar && appConfig.isTabBarPage(this.pageRecord.pagePath)) {
        this.isTabBarContainer = true
        DMPLogger.d(Tags.TABBAR, 'Using TabBar container for launch')
      }
    }

    if (this.isLaunching) {
      this.pageRecord.domReadyListeners.push(() => {
        this.isLaunching = false;
      })
    }
  }

  aboutToDisappear(): void {
    DMPLogger.d(Tags.DMP_PAGE, "DMPPage aboutToDisappear")
  }

  build() {
    NavDestination() {
      Stack() {
        if (this.isTabBarContainer) {
          // Use TabBar container for TabBar apps
          DMPTabBarContainerView({ appIndex: this.appIndex })
        } else {
          // Use normal page container for non-TabBar pages
          DMPPageContainer({ appIndex: this.appIndex, webViewId: this.webViewId })
        }
        if (this.isLaunching) {
          LaunchLoading({
            color: DMPColorUtils.generateColorFromName(this.app!.appConfig.appName),
            name: this.app!.appConfig.appName
          }).width('100%').height('100%')
        }
      }
    }
    .hideTitleBar(true)
    .expandSafeArea([SafeAreaType.KEYBOARD])
    .onShown(() => {
      DMPWindowUtil.setWindowBarDarkMode(getContext(this), this.getPageStyle()?.isStatusBarDarkMode() ?? false)

    })
    .onHidden(() => {

    })
    .onBackPressed(() => {
      // 如果页面还没有 onready 添加事件拦截
      if (DMPAppManager.sharedInstance().getApp(this.appIndex)?.container.isNavigating) {
        return true
      }

      const navigator: DMPNavigatorDelegate | undefined =
        DMPAppManager.sharedInstance().getApp(this.appIndex)?.navigatorManager.getCurNavigator()
      navigator?.pop()

      return true;
    })
    .backgroundColor(Color.Black)

  }

  private getPageStyle(): DMPPageStyle | undefined {
    const pageRecord =
      DMPAppManager.sharedInstance().getApp(this.appIndex)?.navigatorManager.getPageRecordById(this.webViewId)
    if (pageRecord) {
      return pageRecord.pageStyle
    }
    return undefined;
  }
}


