import { DMPPageStyle } from './DMPPageStyle'
import { DMPPageTitle } from './DMPPageTitle'
import { DMPPageRecord } from '../Navigator/DMPPageRecord'
import { DMPAppManager } from '../DApp/DMPAppManager'
import { DMPApp } from '../DApp/DMPApp'
import { display, window } from '@kit.ArkUI'
import { BottomSheetDialog, ListMenu } from '../Bridges/Widget/DMPBottomSheet'
import { ActionSheetController, ActionSheetParams } from '../Bridges/Widget/DMPActionSheetController'
import { DMPTabBar } from '../Components/DMPTabBar'
import { DMPTabBarConfig } from '../Bundle/Model/DMPBundleAppConfigNext'
import { DMPLogger } from '../EventTrack/DMPLogger'
import { Tags } from '../EventTrack/Tags'
import { DMPMap } from '../Utils/DMPMap'

@Component
export struct DMPPageContainer {
  @Prop appIndex: number
  @Prop @Watch('onWebViewIdChange') webViewId: number
  @Prop hideTabBar: boolean = false  // Set to true when inside TabBar container
  private app: DMPApp = DMPAppManager.sharedInstance().getApp(this.appIndex)!
  @State pageRecord: DMPPageRecord = this.app.navigatorManager.getPageRecordById(this.webViewId)!;
  @State pageStyle: DMPPageStyle | undefined = this.pageRecord.pageStyle
  @State safeViewLeft: number = 10
  @State safeViewBottom: number = 80
  @State offsetX: number = 0
  @State offsetY: number = 0
  @State positionX: number = 0
  @State positionY: number = 0
  @State showSafetyView: boolean = false
  private panOption: PanGestureOptions = new PanGestureOptions()
  @State
  keyboardHeight: number = 0
  @State selectedTabIndex: number = 0

  onWebViewIdChange() {
    DMPLogger.d(Tags.TABBAR, `WebViewId changed to: ${this.webViewId}`)
    // Update pageRecord when webViewId changes
    const newPageRecord = this.app.navigatorManager.getPageRecordById(this.webViewId)
    if (newPageRecord) {
      this.pageRecord = newPageRecord
      this.pageStyle = newPageRecord.pageStyle
      this.updateTabBarSelection()
      DMPLogger.d(Tags.TABBAR, `PageRecord updated for path: ${newPageRecord.pagePath}`)
    }
  }

  aboutToAppear(): void {
    this.showSafetyView = false
    this.updateTabBarSelection()

    window.getLastWindow(getContext(this)).then(currentWindow => {
      currentWindow.on('keyboardHeightChange', (data: number) => {
        this.keyboardHeight = px2vp(data);
        console.log('victor', "keyBoardHeight=" + this.keyboardHeight)
      })
    })
    getContext(this).eventHub.on('ps_safety_display', (data: Map<string, number>) => {
      const webViewId: number = data['webViewId'] ?? this.app.currentWebViewId
      if (this.isTopView(webViewId)) {
        const display: number = data['display']
        this.showSafetyView = display == 1
      }
    })

    getContext(this).eventHub.on('ps_safety_layout', (data: Map<string, number>) => {
      const webViewId: number = data['webViewId'] ?? this.app.currentWebViewId
      if (this.isTopView(webViewId)) {
        this.safeViewLeft = data['left'] ?? 10
        this.safeViewBottom = data['bottom'] ?? 80
        this.offsetX = 0
        this.offsetY = 0
        this.positionX = 0
        this.positionY = 0
      }
    })

    this.initActionSheetView()
  }

  isTopView(webViewId: number) {
    return webViewId == this.webViewId
  }

  aboutToDisappear(): void {
    if (this.pageRecord.webViewNodeController) {
      this.pageRecord.webViewNodeController.dispose()
    }

  }

  build() {
    Stack({ alignContent: Alignment.BottomStart }) {
      Column() {
        Row() {
          Column() {
            if (this.pageRecord && !(this.getPageStyle()?.isHideTitleBar(this.webViewId))) {
              DMPPageTitle({ pageRecord: this.pageRecord, appIndex: this.appIndex, webViewId: this.webViewId })
            }
            NodeContainer(this.pageRecord.webViewNodeController)
              .flexShrink(1)
          }
          .width('100%')
          .height('100%')
          .alignItems(HorizontalAlign.Center)
          .justifyContent(FlexAlign.Start)
        }
        .backgroundColor(this.getPageStyle()?.getBackGroundColor() ?? '#ffffff')
        .layoutWeight(1)

        .translate({
          y: (this.pageRecord.adjustPosition > 0 && this.pageRecord.adjustPosition < this.keyboardHeight) ?
            this.pageRecord.adjustPosition - this.keyboardHeight : 0
        })
      }
      .width('100%')
      .height('100%')

      Column() {
        this.getSafetyView()
      }
      .translate({ x: this.offsetX, y: this.offsetY, z: 0 })
      .gesture(PanGesture(this.panOption)// .onActionStart((event: GestureEvent)=>{})
        .onActionUpdate((event: GestureEvent) => {
          this.offsetX = this.positionX + event.offsetX
          this.offsetY = this.positionY + event.offsetY
        })
        .onActionEnd((event: GestureEvent) => {
          this.positionY = this.offsetY
          this.offsetX = this.positionX
        }))
      .visibility(this.showSafetyView ? Visibility.Visible : Visibility.None)
      .margin({
        left: this.safeViewLeft,
        bottom: this.safeViewBottom,
      })

      if (this.pageRecord.isShowLoading) {
        Column() {
          LoadingProgress()
            .color(Color.Black)
            .width(80).height(80)
          Text(this.pageRecord.showLoadingTitle)
            .fontSize(16)
            .fontColor(Color.Black)
        }
        .width('100%')
        .height('100%')
        .backgroundColor('#00000000')
        .justifyContent(FlexAlign.Center)
        .width('100%')
        .height('100%')
      }
    }
  }

  @Builder
  getSafetyView() {
    DMPAppManager.sharedInstance().getApp(this.appIndex)?.customConfig.safetyConfig?.getSafetyShieldView()?.builder()
  }

  private getPageStyle(): DMPPageStyle | undefined {
    const pageRecord =
      DMPAppManager.sharedInstance().getApp(this.appIndex)?.navigatorManager.getPageRecordById(this.webViewId)
    if (pageRecord) {
      return pageRecord.pageStyle
    }
    return undefined
  }

  private shouldShowTabBar(): boolean {
    // Don't show TabBar if explicitly hidden (e.g., inside TabBar container)
    if (this.hideTabBar) {
      return false
    }
    const appConfig = this.app.bundleManager.getJsAppModuleConfig()
    if (!appConfig || !appConfig.tabBar) {
      return false
    }
    return appConfig.isTabBarPage(this.pageRecord.pagePath)
  }

  private getTabBarConfig(): DMPTabBarConfig | undefined {
    return this.app.bundleManager.getJsAppModuleConfig()?.tabBar
  }

  private handleTabSelected(index: number) {
    const tabBarConfig = this.getTabBarConfig()
    if (!tabBarConfig || index >= tabBarConfig.list.length) {
      return
    }

    const targetPath = tabBarConfig.list[index].pagePath
    DMPLogger.d(Tags.TABBAR, `Tab selected: ${index}, path: ${targetPath}`)

    // Update selected index
    this.selectedTabIndex = index

    // Build switchTab params
    const params = new DMPMap()
    params.set('pagePath', targetPath)
    params.set('query', new DMPMap())

    // Call navigator switchTab
    const navigator = this.app.navigatorManager.getCurNavigator()
    if (navigator) {
      navigator.getNavigator().switchTab(params)
    }
  }

  private updateTabBarSelection() {
    const tabBarConfig = this.getTabBarConfig()
    if (!tabBarConfig) {
      return
    }

    // Find the index of current page in tabBar list
    const currentPath = this.pageRecord.pagePath
    const index = tabBarConfig.list.findIndex(item => item.pagePath === currentPath)
    if (index >= 0) {
      this.selectedTabIndex = index
      DMPLogger.d(Tags.TABBAR, `Updated tab selection to index: ${index} for path: ${currentPath}`)
    }
  }

  initActionSheetView() {
    const actionSheetController = new ActionSheetController()
    this.pageRecord.actionSheetController = actionSheetController
    this.pageRecord.actionSheetController.setOnShowCallback((data) => {
      let menuList: ListMenu[] =
        data.items?.map((value, index) => new ListMenu(index, value, data.color)) ?? [];
      let dialogController: CustomDialogController | undefined = undefined;
      dialogController = new CustomDialogController({
        builder: BottomSheetDialog({
          title: data.title ?? '更多操作',
          menuArray: menuList,
          buildController: () => {
            return dialogController!;
          },
          onItemClick: (index) => {
            const onSelectListener = actionSheetController.onSelectListener;
            onSelectListener?.(index)
          }
        }),
        alignment: DialogAlignment.Bottom,
        autoCancel: true
      });
      dialogController.open()
    })
  }
}


