import { DMPAppManager } from '../DApp/DMPAppManager'
import { DMPLogger } from '../EventTrack/DMPLogger'
import { Tags } from '../EventTrack/Tags'

@Component
export struct DMPCapsuleButton {
  @Prop appIndex: number
  @Prop webViewId: number
  private onMoreClick?: () => void
  private onCloseClick?: () => void

  build() {
    Row() {
      Stack() {
        Row({ space: 4 }) {
          Blank()
            .width(4)
            .height(4)
            .borderRadius(2)
            .backgroundColor(this.getForegroundColor())
          Blank()
            .width(7)
            .height(7)
            .borderRadius(4)
            .backgroundColor(this.getForegroundColor())
          Blank()
            .width(4)
            .height(4)
            .borderRadius(2)
            .backgroundColor(this.getForegroundColor())
        }
        .alignItems(VerticalAlign.Center)
        .justifyContent(FlexAlign.Center)
      }
      .width(43)
      .height('100%')
      .alignContent(Alignment.Center)
      .onClick(() => {
        DMPLogger.d(Tags.DMP_PAGE, `Mini program capsule more tapped, webViewId=${this.webViewId}`)
        if (this.onMoreClick) {
          this.onMoreClick()
        }
      })

      Divider()
        .vertical(true)
        .height(16)
        .strokeWidth(0.5)
        .color(this.getBorderColor())

      Stack() {
        Text('')
          .width(18)
          .height(18)
          .borderRadius(9)
          .border({ width: 2.4, color: this.getForegroundColor() })
        Text('')
          .width(6)
          .height(6)
          .borderRadius(3)
          .backgroundColor(this.getForegroundColor())
      }
      .width(43)
      .height('100%')
      .alignContent(Alignment.Center)
      .onClick(() => {
        if (this.onCloseClick) {
          this.onCloseClick()
        } else {
          DMPAppManager.sharedInstance().getApp(this.appIndex)?.navigatorManager.getCurNavigator()?.pop(999)
        }
      })
    }
    .alignItems(VerticalAlign.Center)
    .width(87)
    .height(32)
    .borderRadius(16)
    .border({ width: 0.5, color: this.getBorderColor() })
    .backgroundColor(this.getBackgroundColor())
  }

  private getForegroundColor(): string {
    return '#1f1f1f'
  }

  private getBackgroundColor(): string {
    return '#ffffff'
  }

  private getBorderColor(): string {
    return '#e5e5e5'
  }
}
