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

  constructor(webViewId: number, fromWebViewId: number, pagePath: string, appIndex: number,
    webViewNodeController: DMPWebViewNodeController) {
    this.pagePath = pagePath;
    this.webViewId = webViewId;
    this.fromWebViewId = fromWebViewId;
    this.appIndex = appIndex;
    this.webViewNodeController = webViewNodeController;
  }
}
