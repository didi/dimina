import { DMPAppManager } from '../DApp/DMPAppManager'
import { DMPLogger } from '../EventTrack/DMPLogger'
import { Tags } from '../EventTrack/Tags'
import { DMPMenuButtonLayout } from '../Utils/DMPMenuButtonLayout'

@Component
export struct DMPCapsuleButton {
  @Prop appIndex: number
  @Prop webViewId: number
  @Prop fillColor: ResourceColor
  @Prop iconColor: ResourceColor = '#1f1f1f'
  onMoreClick?: () => void
  onCloseClick?: () => void

  build() {
    Row() {
      Stack() {
        Row({ space: 4 }) {
          Blank()
            .width(4)
            .height(4)
            .borderRadius(2)
            .backgroundColor(this.iconColor)
          Blank()
            .width(7)
            .height(7)
            .borderRadius(4)
            .backgroundColor(this.iconColor)
          Blank()
            .width(4)
            .height(4)
            .borderRadius(2)
            .backgroundColor(this.iconColor)
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
          .border({ width: 2.4, color: this.iconColor })
        Text('')
          .width(6)
          .height(6)
          .borderRadius(3)
          .backgroundColor(this.iconColor)
      }
      .width(43)
      .height('100%')
      .alignContent(Alignment.Center)
      .onClick(() => {
        if (this.onCloseClick) {
          this.onCloseClick()
        } else {
          const app = DMPAppManager.sharedInstance().getApp(this.appIndex)
          if (app) {
            // Mirrors DMPPageContainer.closeMiniProgram: exitMiniProgram (not
            // closeDimina directly) restores the opener when one exists.
            DMPAppManager.sharedInstance().exitMiniProgram(app, async () => {}).catch((error: Error) => {
              DMPLogger.e(Tags.DMP_PAGE, `capsule close failed: ${error.message}`)
            })
          }
        }
      })
    }
    .alignItems(VerticalAlign.Center)
    .width(DMPMenuButtonLayout.capsuleWidth)
    .height(DMPMenuButtonLayout.capsuleHeight)
    .borderRadius(DMPMenuButtonLayout.capsuleHeight / 2)
    .border({ width: 0.5, color: this.getBorderColor() })
    .backgroundColor(this.fillColor)
  }

  private getBorderColor(): string {
    return '#e5e5e5'
  }
}
