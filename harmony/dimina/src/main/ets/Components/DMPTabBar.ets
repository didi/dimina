import { DMPTabBarConfig, DMPTabBarItem } from '../Bundle/Model/DMPBundleAppConfigNext'
import { DMPLogger } from '../EventTrack/DMPLogger'
import { Tags } from '../EventTrack/Tags'

/**
 * TabBar item component
 */
@Component
export struct DMPTabBarItemView {
  @Prop item: DMPTabBarItem = { pagePath: '', text: '' };
  @Prop isSelected: boolean = false;
  @Prop color: string = '#999999';
  @Prop selectedColor: string = '#1890ff';

  build() {
    Column({ space: 2 }) {
      // Icon
      if (this.isSelected && this.item.selectedIconPath) {
        Image(this.item.selectedIconPath)
          .width(24)
          .height(24)
          .objectFit(ImageFit.Contain)
      } else if (!this.isSelected && this.item.iconPath) {
        Image(this.item.iconPath)
          .width(24)
          .height(24)
          .objectFit(ImageFit.Contain)
      } else {
        // No icon: reserve 24vp space for consistent layout
        Row().width(24).height(24)
      }

      // Text
      Text(this.item.text)
        .fontSize(10)
        .fontColor(this.isSelected ? this.selectedColor : this.color)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
    }
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.Center)
    .alignItems(HorizontalAlign.Center)
  }
}

/**
 * TabBar component
 */
@Component
export struct DMPTabBar {
  @Link selectedIndex: number;
  private tabBarConfig: DMPTabBarConfig | undefined = undefined;
  private onTabSelected?: (index: number) => void;

  private getBorderColor(): string {
    if (!this.tabBarConfig) return '#E0E0E0';
    return this.tabBarConfig.borderStyle === 'white' ? '#FFFFFF' : '#E0E0E0';
  }

  private getBackgroundColor(): string {
    return this.tabBarConfig?.backgroundColor || '#FFFFFF';
  }

  build() {
    if (!this.tabBarConfig || !this.tabBarConfig.list || this.tabBarConfig.list.length === 0) {
      Row()
    } else {
      Column() {
        // Top border (0.5vp)
        Row()
          .width('100%')
          .height(0.5)
          .backgroundColor(this.getBorderColor())

        // Tab items row (49vp height, matching 微信小程序 98rpx)
        Row() {
          ForEach(this.tabBarConfig.list, (item: DMPTabBarItem, index: number) => {
            Row() {
              DMPTabBarItemView({
                item: item,
                isSelected: index === this.selectedIndex,
                color: this.tabBarConfig?.color || '#999999',
                selectedColor: this.tabBarConfig?.selectedColor || '#1890ff'
              })
            }
            .layoutWeight(1)
            .height('100%')
            .onClick(() => {
              DMPLogger.d(Tags.TABBAR, `Tab clicked: ${index}`)
              this.selectedIndex = index
              if (this.onTabSelected) {
                this.onTabSelected(index)
              }
            })
          }, (item: DMPTabBarItem, index: number) => `${index}_${item.pagePath}`)
        }
        .width('100%')
        .height(98)
        .backgroundColor(this.getBackgroundColor())
      }
      .width('100%')
      .backgroundColor(this.getBackgroundColor())
      // 全面屏适配：扩展到安全区，自动增加底部安全区高度
      .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.BOTTOM])
    }
  }
}
