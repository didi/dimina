import { DialogEventManager } from './DialogManager';
import { MODAL_DIVIDER_COLOR, MODAL_DIVIDER_WIDTH } from './DMPCommonDialog';

export const entryName: string = 'DMPDialog';

@Entry({ routeName: entryName, storage: LocalStorage.getShared() })
@Component
struct DMPDialog {
  @LocalStorageLink('title') title: string = '';
  @LocalStorageLink('dialogId') dialogId: string = '';
  @LocalStorageLink('content') content: string = '';
  @LocalStorageLink('showCancel') showCancel: boolean = false;
  @LocalStorageLink('cancelText') cancelText: string = '';
  @LocalStorageLink('confirmText') confirmText: string = '';
  @LocalStorageLink('cancelColor') cancelColor: string = '#000000';
  @LocalStorageLink('confirmColor') confirmColor: string = '#576B95';

  build() {
    Row() {
      Flex({ direction: FlexDirection.Column }) {
        Text(this.title ?? '')
          .fontSize(17)
          .fontWeight(FontWeight.Bold)
          .fontColor('#E6000000')
          .lineHeight('23.8fp')
          .textAlign(TextAlign.Center)
          .width('100%')
          .padding({ top: 32, bottom: 16, left: 24, right: 24 })
          .flexShrink(0)

        Scroll() {
          Text(this.content ?? '')
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
          Text(this.cancelText ?? '取消')
            .fontWeight(FontWeight.Bold)
            .fontSize(17)
            .fontColor(this.cancelColor ?? 0x000000)
            .textAlign(TextAlign.Center)
            .height('100%')
            .layoutWeight(1)
            .visibility(this.showCancel ? Visibility.Visible : Visibility.None)
            .onClick(() => {
              DialogEventManager.getInstance().sendEvent(this.dialogId, "cancel")
            })
          Divider()
            .vertical(true)
            .strokeWidth(MODAL_DIVIDER_WIDTH)
            .width(MODAL_DIVIDER_WIDTH)
            .height('100%')
            .color(MODAL_DIVIDER_COLOR)
            .visibility(this.showCancel ? Visibility.Visible : Visibility.None)
          Text(this.confirmText ?? '确定')
            .fontSize(17)
            .fontWeight(FontWeight.Bold)
            .textAlign(TextAlign.Center)
            .fontColor(this.confirmColor)
            .height('100%')
            .layoutWeight(1)
            .onClick(() => {
              DialogEventManager.getInstance().sendEvent(this.dialogId, "confirm")
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
    }.backgroundColor(0x30000000).width('100%').height('100%').justifyContent(FlexAlign.Center)

  }
}
