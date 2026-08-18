import { DMPApp } from '../DApp/DMPApp'
import { DMPPageStyle } from './DMPPageStyle'
import { DMPWindowUtil } from '../Utils/DMPWindowUtils'
import { DMPPageRecord } from '../Navigator/DMPPageRecord'
import { DMPAppManager } from '../DApp/DMPAppManager'
import { DMPMap } from '../Utils/DMPMap'

enum LeftButtonType {
  BACK = 'back',
  CLOSE = 'close',
  NONE = 'none'
}

@Component
export struct DMPPageTitle {
  @Prop
  pageRecord: DMPPageRecord
  @Prop
  appIndex: number
  @Prop
  webViewId: number
  private readonly titleHorizontalInset: number = 110

  aboutToAppear(): void {

  }

  build() {
    Column() {
      Blank()
        .height(px2vp(DMPWindowUtil.getTopSafeArea(DMPApp.getWindowStage())))
      Stack() {
        // 居中标题区域（含 loading 指示器）
        Row() {
          if (this.getPageStyle(this.pageRecord)?.isNavigationBarLoading()) {
            LoadingProgress()
              .width(14)
              .height(14)
              .color(this.getPageStyle(this.pageRecord)?.getTitleTextColor() ?? '#000000')
              .margin({ right: 4 })
          }
          Text(this.getPageStyle(this.pageRecord)?.getTitleString() ?? '')
            .fontSize(18)
            .fontColor(this.getPageStyle(this.pageRecord)?.getTitleTextColor() ?? '#000000')
            .fontWeight('500')
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
        }
        .height('100%')
        .width('100%')
        .padding({ left: this.titleHorizontalInset, right: this.titleHorizontalInset })
        .justifyContent(FlexAlign.Center)

        // 左侧按钮区域
        Row() {
          if (this.getLeftButtonType() === LeftButtonType.BACK) {
            Image($r(this.getPageStyle(this.pageRecord)?.isStatusBarDarkMode() ? 'app.media.ic_dmp_back_black' :
              'app.media.ic_dmp_back_white'))
              .width(55)
              .height(55)
              .padding(15)
              .onClick(() => {
                const embedController =
                  DMPAppManager.sharedInstance().getApp(this.appIndex)?.getWebController(this.webViewId)?.subController
                if (embedController?.accessBackward()) {
                  embedController.backward()
                } else {
                  DMPAppManager.sharedInstance().getApp(this.appIndex)?.navigatorManager.getCurNavigator()?.pop()
                }
              })
          } else if (this.getLeftButtonType() === LeftButtonType.CLOSE) {
            Image($r(this.getPageStyle(this.pageRecord)?.isStatusBarDarkMode() ? 'app.media.ic_dmp_close_black' :
              'app.media.ic_dmp_close_white'))
              .width(44)
              .height(44)
              .padding(12)
              .onClick(() => {
                const app = DMPAppManager.sharedInstance().getApp(this.appIndex)
                if (app?.appConfig?.onContainerClose) {
                  app.appConfig.onContainerClose()
                }
              })
          }

          if (this.shouldShowHomeButton()) {
            Image($r(this.getPageStyle(this.pageRecord)?.isStatusBarDarkMode() ? 'app.media.ic_dmp_home_black' :
              'app.media.ic_dmp_home_white'))
              .width(44)
              .height(44)
              .padding(12)
              .onClick(() => {
                const app = DMPAppManager.sharedInstance().getApp(this.appIndex)
                const entryPagePath = app?.bundleManager.getJsAppModuleConfig()?.entryPagePath
                if (entryPagePath) {
                  const params = new DMPMap()
                  params.set('pagePath', entryPagePath)
                  app?.navigatorManager.getCurNavigator()?.relaunchTo(params)
                }
              })
          }
        }
        .height('100%')
        .alignItems(VerticalAlign.Center)
        .position({ x: 0, y: 0 })
      }
      .width('100%')
      .height(55)
      .alignContent(Alignment.Center)
    }.width('100%')
    .backgroundColor(this.getPageStyle(this.pageRecord)?.getNavigationBarBackGroundColor() ?? '#ffffff')
  }

  private getPageStyle(_: DMPPageRecord): DMPPageStyle | undefined {
    const pageRecord =
      DMPAppManager.sharedInstance().getApp(this.appIndex)?.navigatorManager.getPageRecordById(this.webViewId)
    if (pageRecord) {
      return pageRecord.pageStyle
    }
    return undefined;
  }

  private getLeftButtonType(): LeftButtonType {
    const app = DMPAppManager.sharedInstance().getApp(this.appIndex)
    const nav = app?.navigatorManager.getCurNavigator()
    if (!nav) {
      return LeftButtonType.NONE
    }
    if (nav.getPageCount() > 1) {
      return LeftButtonType.BACK
    }
    // 栈深 = 1，若是 tabBar 页则不显示按钮
    const appConfig = app?.bundleManager.getJsAppModuleConfig()
    if (appConfig?.isTabBarPage(this.pageRecord.pagePath)) {
      return LeftButtonType.NONE
    }
    return LeftButtonType.CLOSE
  }

  private shouldShowHomeButton(): boolean {
    const app = DMPAppManager.sharedInstance().getApp(this.appIndex)
    if (!app) {
      return false
    }
    // 被 wx.hideHomeButton() 隐藏
    if (this.getPageStyle(this.pageRecord)?.isHomeButtonHidden()) {
      return false
    }
    const appConfig = app.bundleManager.getJsAppModuleConfig()
    if (!appConfig) {
      return false
    }
    // tabBar 页不显示 Home 按钮
    if (appConfig.isTabBarPage(this.pageRecord.pagePath)) {
      return false
    }
    const nav = app.navigatorManager.getCurNavigator()
    const pageCount = nav?.getPageCount() ?? 0
    // 栈底页面且不是首页 → 显示
    if (pageCount <= 1 && this.pageRecord.pagePath !== appConfig.entryPagePath) {
      return true
    }
    // page.json 配置了 homeButton: true 且非栈底页
    if (pageCount > 1 && this.getPageStyle(this.pageRecord)?.getHomeButtonConfig()) {
      return true
    }
    return false
  }
}
