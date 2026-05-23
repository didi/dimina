@CustomDialog
export struct DMPMiniProgramMenuDialog {
  controller: CustomDialogController
  private appName: string = ''
  private buildController?: () => CustomDialogController
  private onReenter?: () => void
  private onClose?: () => void

  build() {
    Column() {
      Row() {
        Stack() {
          Text(this.getAppInitial())
            .fontSize(18)
            .fontColor('#8a8a8a')
            .fontWeight(FontWeight.Medium)
        }
        .width(44)
        .height(44)
        .borderRadius(22)
        .backgroundColor('#f4f4f4')
        .alignContent(Alignment.Center)

        Column() {
          Text(this.appName || '小程序')
            .fontSize(18)
            .fontColor('#202020')
            .fontWeight(FontWeight.Bold)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
          Text('小程序')
            .fontSize(14)
            .fontColor('#9a9a9a')
            .margin({ top: 3 })
        }
        .alignItems(HorizontalAlign.Start)
        .margin({ left: 14 })
      }
      .width('100%')
      .height(84)
      .padding({ left: 24, right: 24 })
      .alignItems(VerticalAlign.Center)

      Divider()
        .height(1)
        .backgroundColor('#f2f2f2')

      Row({ space: 16 }) {
        this.MenuItem('↻', 24, '重新进入\n小程序', () => {
          this.closeDialog()
          this.onReenter?.()
        })
        this.MenuItem('×', 26, '关闭小程序', () => {
          this.closeDialog()
          this.onClose?.()
        })
      }
      .width('100%')
      .height(134)
      .padding({ left: 24, right: 24, top: 20, bottom: 20 })
      .alignItems(VerticalAlign.Top)
      .justifyContent(FlexAlign.Start)

      Divider()
        .height(1)
        .backgroundColor('#ededed')

      Text('取消')
        .width('100%')
        .height(58)
        .fontSize(18)
        .fontColor('#576b95')
        .textAlign(TextAlign.Center)
        .onClick(() => {
          this.closeDialog()
        })
    }
    .width('100%')
    .backgroundColor(Color.White)
    .borderRadius(18)
  }

  @Builder
  private MenuItem(icon: string, iconSize: number, title: string, onClick: () => void) {
    Column() {
      Stack() {
        Text(icon)
          .fontSize(iconSize)
          .fontColor('#333333')
          .fontWeight(FontWeight.Medium)
      }
      .width(52)
      .height(52)
      .borderRadius(10)
      .backgroundColor('#f8f8f8')
      .alignContent(Alignment.Center)

      Text(title)
        .width(78)
        .height(34)
        .fontSize(13)
        .fontColor('#686868')
        .textAlign(TextAlign.Center)
        .lineHeight(17)
        .maxLines(2)
        .margin({ top: 8 })
    }
    .width(78)
    .height(94)
    .alignItems(HorizontalAlign.Center)
    .justifyContent(FlexAlign.Start)
    .onClick(() => {
      onClick()
    })
  }

  private getAppInitial(): string {
    return this.appName.length > 0 ? this.appName.substring(0, 1) : '小'
  }

  private closeDialog() {
    if (this.buildController) {
      this.buildController().close()
    }
  }
}
