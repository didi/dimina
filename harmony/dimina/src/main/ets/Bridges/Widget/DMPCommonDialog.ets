export const MODAL_DIVIDER_COLOR: string = '#1A000000'
export const MODAL_DIVIDER_WIDTH: number = 0.5

@CustomDialog
export struct DMPCommonDialog {
  controller: CustomDialogController
  option?: ModalOption

  build() {
    Flex({ direction: FlexDirection.Column }) {
      Text(this.option?.title ?? $r("app.string.dialog_title"))
        .fontSize(17)
        .fontWeight(FontWeight.Bold)
        .fontColor('#E6000000')
        .lineHeight('23.8fp')
        .textAlign(TextAlign.Center)
        .width('100%')
        .padding({ top: 32, bottom: 16, left: 24, right: 24 })
        .flexShrink(0)

      Scroll() {
        Text(this.option?.content ?? '')
          .fontSize(17)
          .fontColor('#80000000')
          .lineHeight('23.8fp')
          .textAlign(TextAlign.Center)
          .padding({ left: 24, right: 24 })
          .width('100%')
      }
      .width('100%')
      .margin({ bottom: 32 })
      .flexShrink(1)
      .edgeEffect(EdgeEffect.None)

      Divider()
        .strokeWidth(MODAL_DIVIDER_WIDTH)
        .color(MODAL_DIVIDER_COLOR)
        .flexShrink(0)

      Row() {
        Text(this.option?.cancelText ?? $r("app.string.dmp_dialog_button_cancel"))
          .fontSize(17)
          .fontWeight(FontWeight.Bold)
          .fontColor(this.option?.cancelColor ?? 0x333333)
          .textAlign(TextAlign.Center)
          .height('100%')
          .layoutWeight(1)
          .onClick(() => {
            this.option?.cancel?.();
          })
          .visibility((this.option?.showCancel ?? true) ? Visibility.Visible : Visibility.None)
        Divider()
          .vertical(true)
          .strokeWidth(MODAL_DIVIDER_WIDTH)
          .width(MODAL_DIVIDER_WIDTH)
          .height('100%')
          .color(MODAL_DIVIDER_COLOR)
          .visibility((this.option?.showCancel ?? true) ? Visibility.Visible : Visibility.None)
        Text(this.option?.confirmText ?? $r("app.string.dmp_dialog_button_confirm"))
          .fontSize(17)
          .fontWeight(FontWeight.Bold)
          .textAlign(TextAlign.Center)
          .fontColor(this.option?.confirmColor ?? '#576B95')
          .height('100%')
          .layoutWeight(1)
          .onClick(() => {
            this.option?.confirm?.();
          })
      }
      .width('100%')
      .height(56)
      .flexShrink(0)
    }
    .height('auto')
    .constraintSize({ maxHeight: '90%' })
    .backgroundColor(0xffffff)
    .width('80%')
    .borderRadius(12)
    .clip(true)
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
