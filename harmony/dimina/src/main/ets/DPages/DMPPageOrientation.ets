import { window } from '@kit.ArkUI'
import { DMPMap } from '../Utils/DMPMap'

/**
 * pageOrientation 配置解析与窗口映射。
 * 非法值等同没写，回落下一级而不是短路成 portrait。
 * Bundle 配置合并和 DMPPageLifecycle 共用这一权威模型。
 */

const VALID_ORIENTATIONS: string[] = ['portrait', 'auto', 'landscape']

export class DMPPageOrientation {
  static isValid(value: string | undefined | null): boolean {
    return value != null && VALID_ORIENTATIONS.indexOf(value) >= 0
  }

  /**
   * page.json 优先于 app.json 的 window 段；两级都缺失或非法时落到 portrait。
   */
  static resolveConfig(pageValue: string | undefined, appValue: string | undefined): string {
    if (DMPPageOrientation.isValid(pageValue)) {
      return pageValue as string
    }
    if (DMPPageOrientation.isValid(appValue)) {
      return appValue as string
    }
    return 'portrait'
  }

  /** 返回已合并的页面配置方向；缺失或非法时落到 portrait。 */
  static computed(navStyle: DMPMap): string {
    const config: string = navStyle.get('pageOrientation')
    return DMPPageOrientation.isValid(config) ? config : 'portrait'
  }

  /**
   * 页面上屏（onShow）这一刻读到的几何，是不是这一页接下来会一直保持的几何——只有它成立，当时读到的尺寸才配作为这一页的 resize 上报出去。
   * 两条独立的事实都要成立：
   * - requestsNewOrientation 为 false：这次上屏自己不会请求一次新的窗口方向。要请求就说明
   * 紧接着会有一次真正的几何变化，此刻读到的还是上一个页面遗留的几何，报出去等于把别人的方向安到这一页头上（auto 页从固定横屏页返回就是这个情形：窗口还是横的，马上要变竖）。
   * - 更早一次方向请求已经落地：固定方向页要求当前 deviceOrientation 恰好等于目标方向，
   * 不等就是上一次请求还在路上。
   * auto 页把方向交给传感器，没有可比的期望值，这一条对它恒真，只能靠上一条把「正要发起的变化」挡住。
   * 不成立时不是丢掉这次上报，而是交给权威的窗口尺寸变化回调（DMPApp.pageOrientationMetricsChangeCallback）在方向真正生效后上报。
   * 判据只管 resize 上报；pageShow 要不要跟着等由 {@link defersPageShow} 单独判定。
   */
  static isGeometrySettled(computed: string, requestsNewOrientation: boolean, deviceOrientation: string): boolean {
    if (computed === 'auto') {
      return !requestsNewOrientation
    }
    // A fixed page already showing its requested direction is settled even if this owner has not submitted the idempotent platform request yet.
    // Waiting would deadlock when no size event fires.
    return computed === deviceOrientation
  }

  /**
   * 几何还没落地时，pageShow 要不要跟着等。
   * 判据比 {@link isGeometrySettled} 窄，因为两者押后的代价不同：resize 早报一步是把上一页的方向安到这一页头上，pageShow 晚报一步却可能让这一页永远收不到 onShow —— 放行它的只有窗口几何回调，而方向请求完全可能不产生任何几何事件（平台拒绝、窗口不可用、或请求后窗口方向根本没变）。
   * 因此只有能证明「紧接着必然有一次窗口方向变化」时才等：固定方向页要求的方向与当前 deviceOrientation 不一致，就是这个证明。
   * auto 页要求的是「跟随传感器」，容器读不到设备姿态（display.orientation 是界面方向，本身就受 preferred orientation 约束），证明不了窗口会不会变，就不等——设备本来就处在传感器方向时平台不会发任何几何事件。
   * iOS 在拿不到 device posture 时同样退回立即 pageShow（DMPPageController.shouldRunPageShowImmediately）。
   */
  static defersPageShow(computed: string, deviceOrientation: string): boolean {
    return computed !== 'auto' && computed !== deviceOrientation
  }

  /**
   * 押着的 pageShow 该不该在这次窗口 metrics 事件上放行。两种放行理由：
   * - 几何已经落地：等的那次方向变化到了，此刻读到的就是这一页会保持的几何。
   * - 押后的证明不再成立：押后的前提是「窗口接下来一定会转」，请求在途中窗口被拖进
   * 分屏/悬浮窗后平台受理请求却不转窗口，这个前提失效，继续等就没有任何放行者了。
   * 与 Android 在每次几何事件上重判 defersPageShowFor 同构，不引入超时兜底。
   */
  static releasesPendingPageShow(settled: boolean, defersPageShow: boolean): boolean {
    return settled || !defersPageShow
  }

  /**
   * 窗口 metrics 事件要不要作为一次 resize 报出去。
   * 基线按**小程序**存（不按页）：这条订阅上还挂着键盘收起、状态栏显隐，判据把「来了一次 metrics 事件」收敛成「窗口真的变了」—— 窗口几何这条通道只在尺寸真的变了时才上报。
   *
   * 首次（`lastReportedGeometry` 为空串）只记基线：窗口此刻刚布局出来，没有发生过变化。
   *
   * 「哪一页收到 Page.onResize」不由这里决定——它由上报时指名的 bridgeId 决定，路由落地时另有一次无条件上报（见 DMPPageLifecycle.reportRouteGeometry）。
   */
  static dispatchesResize(lastReportedGeometry: string, geometry: string): boolean {
    return lastReportedGeometry !== '' && lastReportedGeometry !== geometry
  }

  /**
   * auto 用 AUTO_ROTATION_RESTRICTED 而非 AUTO_ROTATION：用户关闭系统自动旋转开关时不应该被小程序强行转起来。
   * 固定横屏使用 AUTO_ROTATION_LANDSCAPE，让两个横屏方向都跟随传感器且忽略旋转锁，与 Android SENSOR_LANDSCAPE 和 iOS `.landscape` 一致。
   */
  static toWindowOrientation(config: string): window.Orientation {
    if (config === 'landscape') {
      return window.Orientation.AUTO_ROTATION_LANDSCAPE
    }
    if (config === 'auto') {
      return window.Orientation.AUTO_ROTATION_RESTRICTED
    }
    return window.Orientation.PORTRAIT
  }
}
