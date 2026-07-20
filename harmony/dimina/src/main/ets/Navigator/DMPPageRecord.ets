import { ActionSheetController } from '../Bridges/Widget/DMPActionSheetController'
import { DMPPageStyle } from '../DPages/DMPPageStyle'
import { DMPWebViewNodeController } from '../HybridContainer/DMPWebViewNodeController'
import { DMPMap } from '../Utils/DMPMap'
import { DomReadyListener } from './DMPNavigatorManager'


@Observed
export class DMPPageRecord {
  webViewId: number
  fromWebViewId: number
  pagePath: string
  params: DMPMap | undefined
  navStyle: DMPMap | undefined
  pageStyle: DMPPageStyle | undefined
  componentParams: Map<string, DMPMap> = new Map()
  isShowLoading: boolean = false;
  showLoadingTitle: string = '';
  showLoadingMask: boolean = false
  appIndex: number
  webViewNodeController: DMPWebViewNodeController
  adjustPosition: number = 0
  actionSheetController?: ActionSheetController;
  domReadyListeners: DomReadyListener[] = [];
  // 同层嵌入 web-view 是否有可回退历史的镜像（EmbedWebView 导航事件同步；真相源是
  // 嵌入 controller 的 accessBackward()）。作为 @State/@Observed 一层属性，赋值即触发
  // 页面标题栏重建，使栈底页的返回箭头随嵌入历史出现/消失
  embeddedCanGoBack: boolean = false
  // 这条记录是否在共享 NavPathStack（DRouter 单例内部持有的那一份原生栈，见 DRouter.ets）
  // 里真正占用了一个槽位。经 DRouter push/replace 挂载的页面（DMPOpenType.NavigateTo /
  // Insert）为 true；customLaunchPageCallBack 场景由宿主自行挂载页面、从未进入
  // NavPathStack，为 false。unwind 一条记录时是否要对应调用 DRouter.pop() 只认这个字段
  // （见 shouldPopRouter），不要在别处另起一套算术判断
  ownsRouterEntry: boolean = true

  constructor(webViewId: number, fromWebViewId: number, pagePath: string, appIndex: number,
    webViewNodeController: DMPWebViewNodeController) {
    this.pagePath = pagePath;
    this.webViewId = webViewId;
    this.fromWebViewId = fromWebViewId;
    this.appIndex = appIndex;
    this.webViewNodeController = webViewNodeController;
  }

  /**
   * openPage 用来决定新记录是否占用共享 NavPathStack 槽位：customLaunchPageCallBack 存在时
   * 页面完全绕过 DRouter，由宿主自行挂载，从未占槽位
   */
  static computeOwnsRouterEntry(hasCustomLaunchPageCallBack: boolean): boolean {
    return !hasCustomLaunchPageCallBack
  }

  /**
   * 判断 unwind 一条页面记录时是否需要对应调用 DRouter.pop()：只有真正占了共享
   * NavPathStack 槽位的记录才需要——customLaunchPageCallBack 挂载的页面对它调用
   * DRouter.pop() 会误弹别的页面。DMPNavigator.pop()/closeAllPages() 共用这一个判据。
   * 栈已空、拿不到记录时保守返回 true，与两处调用方原有行为一致
   */
  static shouldPopRouter(ownsRouterEntry: boolean | undefined): boolean {
    return ownsRouterEntry !== false
  }
}
