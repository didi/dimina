import { DialogEventManager } from './DialogManager';

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
      Column() {
        Text(this.title ?? '')
          .fontSize(16)
          .fontWeight(FontWeight.Bold)
          .fontColor(0x202020).margin({ top: 18 })

        Scroll() {
          Text(this.content ?? '')
            .fontSize(16)
            .fontColor(0x747474)
            .padding({
              top: 20,
              bottom: 30,
              left: 16,
              right: 16
            })
            .width('100%')
        }
        .width('100%')
        .flexShrink(1)
        .edgeEffect(EdgeEffect.None)

        Divider().strokeWidth(1).color(0xf2f2f2)

        Flex({ justifyContent: FlexAlign.SpaceEvenly, alignItems: ItemAlign.Center }) {
          Text(this.cancelText ?? '取消')
            .fontWeight(FontWeight.Bold)
            .fontSize(16)
            .fontColor(this.cancelColor ?? 0x000000)
            .textAlign(TextAlign.Center)
            .height('100%')
            .width('50%')
            .visibility(this.showCancel ? Visibility.Visible : Visibility.None)
            .onClick(() => {
              DialogEventManager.getInstance().sendEvent(this.dialogId, "cancel")
            })
          Divider()
            .vertical(true)
            .strokeWidth(1)
            .color(0xf2f2f2)
            .visibility(this.showCancel ? Visibility.Visible : Visibility.None)
          Text(this.confirmText ?? '确定')
            .fontSize(16)
            .fontWeight(FontWeight.Bold)
            .textAlign(TextAlign.Center)
            .fontColor(this.confirmColor)
            .height('100%')
            .width('50%')
            .onClick(() => {
              DialogEventManager.getInstance().sendEvent(this.dialogId, "confirm")
            })
        }
        .height(45)
      }
      .constraintSize({ maxHeight: '90%' })
      .backgroundColor(0xffffff)
      .margin({ left: 40, right: 40 })
      .borderRadius(6)
    }.backgroundColor(0x30000000).width('100%').height('100%').justifyContent(FlexAlign.Center)

  }
}
