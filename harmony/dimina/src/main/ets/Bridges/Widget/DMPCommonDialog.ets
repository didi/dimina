@CustomDialog
export struct DMPCommonDialog {
  controller: CustomDialogController
  option?: ModalOption

  build() {
    Column() {
      Text(this.option?.title ?? $r("app.string.dialog_title"))
        .fontSize(18)
        .fontWeight(FontWeight.Bold)
        .fontColor(0x333333).margin({ top: 18 })

      Scroll() {
        Text(this.option?.content ?? '')
          .fontSize(16)
          .fontColor(0x666666)
          .margin({ top: 17, bottom: 17 })
          .width('100%')
      }
      .width('100%')
      .flexShrink(1)
      .edgeEffect(EdgeEffect.None)

      Divider().strokeWidth(1).color('#c8c8c8')

      Flex({ justifyContent: FlexAlign.SpaceEvenly, alignItems: ItemAlign.Center }) {
        Text(this.option?.cancelText ?? $r("app.string.dmp_dialog_button_cancel"))
          .fontSize(16)
          .fontColor(this.option?.cancelColor ?? 0x333333)
          .textAlign(TextAlign.Center)
          .height('100%')
          .width('50%')
          .onClick(() => {
            this.option?.cancel?.();
          })
          .visibility(this.option?.showCancel ? Visibility.Visible : Visibility.None)
        Divider()
          .vertical(true)
          .strokeWidth(1)
          .color('#c8c8c8')
          .visibility(this.option?.showCancel ? Visibility.Visible : Visibility.None)
          .backgroundColor('#ff0000')
        Text(this.option?.confirmText ?? $r("app.string.dmp_dialog_button_confirm"))
          .fontSize(16)
          .textAlign(TextAlign.Center)
          .fontColor('#576B95')
          .height('100%')
          .width('50%')
          .onClick(() => {
            this.option?.confirm?.();
          })
      }
      .height(45)
    }
    .constraintSize({ maxHeight: '90%' })
    .backgroundColor(0xffffff)
    .margin({ left: 40, right: 40 })
    .borderRadius(6)
  }
}

export declare interface ModalOption {
  dialogId?: string;
  cancel?: () => void;
  confirm?: () => void;
  fail?: () => void;
  title?: string;
  content?: string;
  showCancel?: Boolean;
  cancelText?: string;
  cancelColor?: string;
  confirmText?: string;
  confirmColor?: string;
}
