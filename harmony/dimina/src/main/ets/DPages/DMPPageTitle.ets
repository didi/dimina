import { DMPApp } from '../DApp/DMPApp'
import { DMPPageStyle } from './DMPPageStyle'
import { DMPWindowUtil } from '../Utils/DMPWindowUtils'
import { DMPPageRecord } from '../Navigator/DMPPageRecord'
import { DMPAppManager } from '../DApp/DMPAppManager'

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
}
