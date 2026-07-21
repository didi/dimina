import { DMPApp } from '../DApp/DMPApp'
import { DMPPageStyle } from './DMPPageStyle'
import { DMPWindowUtil } from '../Utils/DMPWindowUtils'
import { DMPPageRecord } from '../Navigator/DMPPageRecord'
import { DMPAppManager } from '../DApp/DMPAppManager'
import { DMPMenuButtonLayout } from '../Utils/DMPMenuButtonLayout'
import { DMPLogger } from '../EventTrack/DMPLogger'
import { Tags } from '../EventTrack/Tags'

@Component
export struct DMPPageTitle {
  @Prop
  pageRecord: DMPPageRecord
  @Prop
  appIndex: number
  @Prop
  webViewId: number
  private readonly titleHorizontalInset: number = DMPMenuButtonLayout.titleHorizontalInset
  // Material Icons 的 home 造型（与各端返回箭头同属 Material 图标体系），
  // 原始 24×24 path 缩放到 55 触控区居中的 22px 视区（16.5px 内边距），叠在灰色圆形底上
  // （见 build() 里的 Circle），对齐微信真机 home 图标的圆底+图标组合
  private readonly homeIconCommands: string =
    'M25.7 34.8 L25.7 29.3 L29.3 29.3 L29.3 34.8 L33.9 34.8 L33.9 27.5 L36.7 27.5 L27.5 19.3 L18.3 27.5 L21.1 27.5 L21.1 34.8 Z'

  aboutToAppear(): void {

  }

  build() {
    Column() {
      Blank()
        .height(px2vp(DMPWindowUtil.getTopSafeArea(DMPApp.getWindowStage())))
      Stack() {
        Text(this.getPageStyle(this.pageRecord)?.getTitleString() ?? '')
          .height('100%')
          .width('100%')
          .padding({ left: this.titleHorizontalInset, right: this.titleHorizontalInset })
          .fontSize(18)
          .fontColor(this.getPageStyle(this.pageRecord)?.getTitleTextColor() ?? '#000000')
          .fontWeight('500')
          .textAlign(TextAlign.Center)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })

        if (this.showBackButton()) {
          Image($r(this.getPageStyle(this.pageRecord)?.isStatusBarDarkMode() ? 'app.media.ic_dmp_back_black' :
            'app.media.ic_dmp_back_white'))
            .width(55)
            .height(55)
            .padding(15)
            .position({ x: 0, y: 0 })
            .onClick((event?: ClickEvent) => {
              const embedController =
                DMPAppManager.sharedInstance().getApp(this.appIndex)?.getWebController(this.webViewId)?.subController
              if (embedController?.accessBackward()) {
                embedController.backward()
              } else {
                DMPAppManager.sharedInstance().getApp(this.appIndex)?.navigatorManager.getCurNavigator()?.pop()
              }
            })
        }
        // 返回首页按钮独立判定：homeButton: true 的内页与返回箭头并存
        // （微信实测样式），此时让出左槽紧随箭头之后
        if (this.showHomeButton()) {
          // 微信真机 home 图标带灰色圆形底，比返回箭头更粗更显眼；圆底色随导航栏深浅切换。
          // 返回箭头/home 两个 55vp 触控槽位自带留白（各自图标居中，槽位比图标本身大），
          // 不再额外叠加槽位间距，否则视觉间距会远超微信原生
          // `.navigator-hd a+a{margin-left:10px}` 的 10vp
          Circle({ width: 55, height: 55 })
            .padding(11.5)
            .fill(this.getPageStyle(this.pageRecord)?.isStatusBarDarkMode() ? 'rgba(255,255,255,0.24)' : '#D6D6D6')
            .position({ x: this.showBackButton() ? 55 : 0, y: 0 })
          Path({ width: 55, height: 55, commands: this.homeIconCommands })
            .fill(this.getPageStyle(this.pageRecord)?.getTitleTextColor() ?? '#000000')
            .position({ x: this.showBackButton() ? 55 : 0, y: 0 })
            .onClick(() => {
              this.goHome()
            })
        }
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

  // 返回箭头显示判据：tabBar 页永不显示（tab 页经 tabBar 即可离开，微信亦无箭头）；
  // 栈深 > 1 显示；栈底页面仅当嵌入 web-view（同层渲染）自身有可回退历史时保留箭头
  // （点击优先回退嵌入历史，见 onClick）。读 pageRecord.embeddedCanGoBack 镜像而非直接
  // 轮询 controller——镜像赋值本身就是标题栏的重建信号（见 EmbedWebView.syncEmbeddedHistoryState），
  // 保证箭头随嵌入历史出现/消失。栈底箭头与返回首页按钮互斥，见 shouldShowHomeButton
  private showBackButton(): boolean {
    const app = DMPAppManager.sharedInstance().getApp(this.appIndex)
    if (!app) {
      return true // app 尚不可用时维持既有箭头展示，不误藏
    }
    const pageRecord = app.navigatorManager.getPageRecordById(this.webViewId)
    const pagePath = pageRecord?.pagePath
    if (pagePath && app.bundleManager.getJsAppModuleConfig()?.isTabBarPage(pagePath)) {
      return false
    }
    if (app.navigatorManager.getPageCountForWebViewId(this.webViewId) > 1) {
      return true
    }
    return pageRecord?.embeddedCanGoBack === true
  }

  private showHomeButton(): boolean {
    return this.getPageStyle(this.pageRecord)?.shouldShowHomeButton(this.webViewId) ?? false
  }

  // 路由判定收敛在 DMPNavigator.navigateHome（switchTab / redirectTo 的选择），标题栏只发起
  private goHome(): void {
    const navigator = DMPAppManager.sharedInstance().getApp(this.appIndex)?.navigatorManager.getCurNavigator()
    navigator?.navigateHome().catch((err: Error) => {
      DMPLogger.e(Tags.NAVIGATOR, `navigateHome failed: ${err?.message ?? err}`)
    })
  }
}
