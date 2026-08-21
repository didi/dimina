import { DMPApp } from '../DApp/DMPApp';
import { DMPAppManager } from '../DApp/DMPAppManager';
import { DMPLogger } from '../EventTrack/DMPLogger';
import { Tags } from '../EventTrack/Tags';
import { DMPChannelProxyNext } from '../Service/DMPChannelProxyNext';
import { DMPMap } from '../Utils/DMPMap';
import { DMPDeviceUtil } from '../Utils/DMPDeviceUtils';
import { DMPPageOrientation } from './DMPPageOrientation';

export class DMPPageShowLedger {
  private generation: number = 0
  private webViewId: number = -1

  claim(webViewId: number): number {
    this.generation += 1
    this.webViewId = webViewId
    return this.generation
  }

  invalidate(webViewId: number): void {
    this.generation += 1
    if (this.webViewId === webViewId) {
      this.webViewId = -1
    }
  }

  isPending(webViewId: number, generation: number): boolean {
    return generation === this.generation && webViewId === this.webViewId
  }

  take(webViewId: number, generation: number): boolean {
    if (!this.isPending(webViewId, generation)) {
      return false
    }
    this.webViewId = -1
    return true
  }

  currentGeneration(): number {
    return this.generation
  }
}

/** onShow 这一刻的两个独立判定，见 DMPPageOrientation 的 isGeometrySettled / defersPageShow。 */
interface DMPPageGeometryGate {
  settled: boolean
  defersPageShow: boolean
}

export class DMPPageLifecycle {
  app: DMPApp
  private pageShowLedger: DMPPageShowLedger = new DMPPageShowLedger()

  constructor(app: DMPApp) {
    this.app = app;
  }

  onShow(webviewId: number) {
    DMPLogger.i(Tags.ON_PAGE_SHOW, `webviewId:${webviewId}`)
    const generation = this.pageShowLedger.claim(webviewId)

    if (!DMPApp.isPageOrientationEnabled()) {
      this.flushPageShow(webviewId, generation)
      return
    }
    // 这一页正在上屏，就是「屏幕上有这个 app 的页面」这件事发生的时刻。
    // ArkUI 的 onShown 要到下一帧才把它记进账本，而下面押出去的 pageShow 只有拥有窗口的 app 才收得到几何回调—— 无主时先认领，把这段空窗关掉（见 DMPForegroundAppLedger.claimIfUnowned）。
    DMPAppManager.sharedInstance().claimWindowIfUnowned(this.app.appIndex)
    // 只有能证明窗口接下来一定会转时才押后 pageShow（方向请求的 promise 先于窗口变化 resolve，所以「一定会转」要靠配置与当前方向的对比来证，不能靠请求成没成功）。
    // 证明不了就地放行，押着的那条由 flushPendingPageShow / releasePageShowWithoutNewGeometry 兜底。
    // 两条路都是 pageShow 在前、几何在后：service 只把已经 show 的页面登记成 Page.onResize 的收件人，反过来这条几何就送不到它手上。
    const gate = DMPPageLifecycle.geometryGateFor(this.app, webviewId)
    if (!gate.defersPageShow && this.flushPageShow(webviewId, generation)) {
      // 只有真的把 pageShow 送出去了才报这一页的几何：flushPageShow 判 false 说明这一页已经不是当前页（onShow 与路由推进交错），拿它的 bridgeId 上报会把几何送给一个 service 侧已经不再显示的页，还顺带推进应用级基线。
      DMPPageLifecycle.reportRouteGeometry(this.app, webviewId)
    }
    // 页面栈每次转移完成后重新按新栈顶页解算并应用方向：onShow 是 navigateTo/redirectTo/reLaunch/navigateBack/switchTab 共用的换页收尾点（见 DMPNavigator.openPage/realRedirectTo/pop/updateTabBarSelection）还在等新几何时，pageShow 押在窗口 metrics 回调上，而请求被平台拒绝或被更新的请求取代时那个回调永远不会来——方向请求的结局必须自己兜底放行，页面可见性不能取决于它成不成功。
    DMPPageLifecycle.applyOrientationAsync(this.app, webviewId)
      .then((applied: boolean) => {
        // 请求成功也只说明平台受理了，不说明窗口一定会动：目标方向此刻可能已经生效（分屏、折叠态或另一次请求先把窗口转过去了），那样就不会再有任何几何事件来放行 pageShow。
        // 重新取一次几何判据，已经落地就地放行；没落地才继续等权威回调——判据成立的那一刻读到的正是这一页会保持的几何，与回调里报的是同一份。
        // 已经放行过的 pageShow 在那里是无操作，也就不会多报一次。
        if (!applied || DMPPageLifecycle.geometryGateFor(this.app, webviewId).settled) {
          this.releasePageShowWithoutNewGeometry(webviewId, generation)
        }
      })
      .catch((err: Error) => {
        DMPLogger.e(Tags.ON_PAGE_SHOW, `applyOrientation failed: ${err.message}`)
        this.releasePageShowWithoutNewGeometry(webviewId, generation)
      })
  }

  /**
   * 方向请求已经结案、窗口不会再因为它变了：此刻读到的正是这一页会一直保持的几何。
   * 已经放行过的 pageShow 在这里是无操作（账本只认还挂着的那一次）。
   * 放行在前、上报在后，与 onShow 和窗口 metrics 回调是同一个顺序。
   */
  private releasePageShowWithoutNewGeometry(webviewId: number, generation: number): void {
    if (this.app.currentWebViewId !== webviewId
      || !this.pageShowLedger.isPending(webviewId, generation)) {
      return
    }
    this.flushPageShow(webviewId, generation)
    DMPPageLifecycle.reportRouteGeometry(this.app, webviewId)
  }

  /**
   * 权威的窗口 metrics 回调在上报几何之前调这里。
   *
   * 但那条回调并不只跟着方向走：DMPDeviceUtil 把 windowSizeChange 和 avoidAreaChange 订阅在同一个入口上，键盘收起、状态栏显隐都会走到这里。
   * 押着的 pageShow 等的是「这一页的方向落地」，不是「来了任意一次 metrics 事件」——几何还没落地就放行，onShow 读到的是上一页的方向，而固定方向页的两条 resize 通道都被 service 的 resolveResizeDispatch 抑制，这一页再也纠正不回来。
   * 所以这里重新取一次判据，只有落地了才放行。
   *
   * 不会因此饿死：真正的方向变化必然带来一次 windowSizeChange，那一次判据就成立了；请求被拒绝或根本没产生几何事件的情形由 releasePageShowWithoutNewGeometry 兜底。
   *
   * 还有一条放行理由与「落地」无关：押后的前提是能证明窗口接下来一定会转，而这个证明只在 onShow 那一刻取过一次。
   * 请求在途中窗口被拖进分屏/悬浮窗时平台会受理方向请求却不转窗口，前提就此失效——此时 releasePageShowWithoutNewGeometry 的一次性兜底已经消耗掉（applied 为真、几何未落地），只判 settled 的话这条 pageShow 再也没有放行者。
   * 所以这里重取判据时连同证明一起判，与 Android 每次几何事件重判 defersPageShowFor 同构。
   */
  flushPendingPageShow(webviewId: number): boolean {
    const gate: DMPPageGeometryGate = DMPPageLifecycle.geometryGateFor(this.app, webviewId)
    if (!DMPPageOrientation.releasesPendingPageShow(gate.settled, gate.defersPageShow)) {
      return false
    }
    return this.flushPageShow(webviewId, this.pageShowLedger.currentGeneration())
  }

  /** @returns 是否真的把 pageShow 发了出去；账本只认还挂着的那一次。 */
  private flushPageShow(webviewId: number, generation: number): boolean {
    if (this.app.currentWebViewId !== webviewId
      || !this.pageShowLedger.take(webviewId, generation)) {
      return false
    }
    const msg: DMPMap = new DMPMap({
      type: 'pageShow',
      body: { bridgeId: webviewId }
    })
    DMPChannelProxyNext.ContainerToService(msg, this.app.appIndex)
    return true
  }

  /**
   * 给 webviewId 这一页取齐判据需要的三个事实，交给 {@link DMPPageOrientation} 的两条纯判定：这一页解算出的方向、这次上屏会不会请求一次新的窗口方向、当前已经生效的 deviceOrientation。
   * 判定规则只此一份，这里不重复。
   * 页面记录已经不在时两条都取假：没有配置可解算，也没有任何几何变化值得等。
   */
  private static geometryGateFor(app: DMPApp, webviewId: number): DMPPageGeometryGate {
    const record = app.navigatorManager.getPageRecordById(webviewId)
    if (!record) {
      return { settled: false, defersPageShow: false }
    }
    const navStyle = record.pageStyle?.navStyle ?? new DMPMap()
    const computed = DMPPageOrientation.computed(navStyle)
    const requestsNewOrientation: boolean =
      DMPDeviceUtil.requestsNewOrientation(DMPPageOrientation.toWindowOrientation(computed))
    const metrics = DMPDeviceUtil.getSafeAreaAndDisplayWHSync()
    const deviceOrientation = metrics.getString('deviceOrientation') ?? 'portrait'
    return {
      settled: DMPPageOrientation.isGeometrySettled(computed, requestsNewOrientation, deviceOrientation),
      // 押后的前提是能证明窗口接下来一定会转。
      // 窗口不整屏时平台受理方向请求却不转窗口，那个证明就不成立，押着的 pageShow 没有放行者（见 DMPDeviceUtil.windowCanRotate）。
      defersPageShow: DMPDeviceUtil.windowCanRotate()
        && DMPPageOrientation.defersPageShow(computed, deviceOrientation)
    }
  }

  onHide(webviewId: number) {
    DMPLogger.i(Tags.ON_PAGE_HIDE, `webviewId:${webviewId}`)
    this.pageShowLedger.invalidate(webviewId)
    if (webviewId <= 0) {
      return;
    }

    const msg: DMPMap = new DMPMap({
      type: 'pageHide',
      body: {
        bridgeId: webviewId
      }
    })
    DMPChannelProxyNext.ContainerToService(msg, this.app.appIndex)
  }

  onUnload(webviewId: number) {
    const msg: DMPMap = new DMPMap({
      type: 'pageUnload',
      body: {
        bridgeId: webviewId
      }
    })
    DMPChannelProxyNext.ContainerToService(msg, this.app.appIndex)
  }

  /**
   * 单一权威：页面栈转移与窗口尺寸变化都从页面配置解算并应用方向，避免各入口分别解释配置。
   * 失败只记日志，不外抛。
   */
  static applyOrientation(app: DMPApp, webviewId: number): void {
    if (!DMPApp.isPageOrientationEnabled()) {
      return
    }
    DMPPageLifecycle.applyOrientationAsync(app, webviewId).catch((err: Error) => {
      DMPLogger.e(Tags.ON_PAGE_SHOW, `applyOrientation failed: ${err.message}`)
    })
  }

  /** 应用配置方向；窗口重新布局完成后的几何由窗口订阅回调上报。 */
  static async applyOrientationAsync(app: DMPApp, webviewId: number): Promise<boolean> {
    if (!DMPApp.isPageOrientationEnabled()) {
      return false
    }
    const record = app.navigatorManager.getPageRecordById(webviewId)
    if (!record) {
      return false
    }
    const navStyle = record.pageStyle?.navStyle ?? new DMPMap()
    const computed = DMPPageOrientation.computed(navStyle)
    const orientation = DMPPageOrientation.toWindowOrientation(computed)
    const result = await DMPDeviceUtil.applyPreferredOrientation(orientation)
    if (result.error) {
      DMPDeviceUtil.invalidateFailedOrientationRequest(result.generation, orientation)
    }
    return DMPPageLifecycle.settleOrientationRequest(
      DMPDeviceUtil.isLatestOrientationGeneration(result.generation),
      result.error
    )
  }

  /** Superseded platform results are inert; only the current failure propagates. */
  static settleOrientationRequest(isCurrent: boolean, error?: Error): boolean {
    if (!isCurrent) {
      return false
    }
    if (error) {
      throw error
    }
    return true
  }

  /**
   * 路由落地后把当前页所在窗口的几何报一次，不比对几何：`Page.onResize` 的收件人由宿主指名，每次路由（含 appLaunch）都报落点页。
   * 缓存页回到一个「它自己没变、窗口也没再动」的几何时，只有这一条能让它收到。
   */
  static reportRouteGeometry(app: DMPApp, webviewId: number): void {
    DMPPageLifecycle.settleGeometry(app, webviewId, true)
  }

  /**
   * 窗口尺寸/避让区变化时上报当前页的几何，几何没动就只是一次无关事件（键盘、状态栏），判据见 {@link DMPPageOrientation.dispatchesResize}。
   */
  static reportGeometryIfChanged(app: DMPApp, webviewId: number): void {
    DMPPageLifecycle.settleGeometry(app, webviewId, false)
  }

  /**
   * @param unconditional true 表示路由落地那条无条件上报；false 表示窗口事件那条，
   *   要与小程序级基线比过才报。两条都会推进基线——基线记的是 service 已经知道的几何。
   */
  private static settleGeometry(app: DMPApp, webviewId: number, unconditional: boolean): void {
    if (!DMPApp.isPageOrientationEnabled()) {
      return
    }
    const record = app.navigatorManager.getPageRecordById(webviewId)
    if (!record) {
      return
    }
    const navStyle = record.pageStyle?.navStyle ?? new DMPMap()
    const metrics = DMPDeviceUtil.getSafeAreaAndDisplayWHSync()
    const screenWidth: number = metrics.getNumber('screenWidth') ?? 0
    const screenHeight: number = metrics.getNumber('screenHeight') ?? 0
    const windowWidth: number = metrics.getNumber('windowWidth') ?? 0
    const windowHeight: number = metrics.getNumber('windowHeight') ?? 0
    const deviceOrientation: string = metrics.getString('deviceOrientation') ?? 'portrait'

    const geometry = `${windowWidth}x${windowHeight}@${deviceOrientation}`
    const dispatches: boolean =
      unconditional || DMPPageOrientation.dispatchesResize(app.lastReportedGeometry, geometry)
    app.lastReportedGeometry = geometry

    if (!dispatches) {
      return
    }

    const msg: DMPMap = new DMPMap({
      type: 'pageResize',
      body: {
        bridgeId: record.webViewId,
        // 屏幕尺寸和窗口尺寸都给：前者是整块屏幕，后者扣掉状态栏与导航栏，旋转时两组一起换宽高。
        size: {
          screenWidth: screenWidth,
          screenHeight: screenHeight,
          windowWidth: windowWidth,
          windowHeight: windowHeight
        },
        deviceOrientation: deviceOrientation,
        pageOrientation: {
          originalPageOrientation: navStyle.getString('pageOrientation') ?? 'portrait'
        }
      }
    })
    DMPChannelProxyNext.ContainerToService(msg, app.appIndex)
  }
}