import { DMPMap } from './DMPMap'
import { display, window } from '@kit.ArkUI'

export type DMPDeviceMetricsChangeCallback = (metrics: DMPMap) => void

export interface DMPOrientationRequestResult {
  generation: number
  error?: Error
}

interface DMPPendingOrientationRequest {
  orientation: window.Orientation
  promise: Promise<DMPOrientationRequestResult>
}

export interface DMPOrientationRequestClaim {
  generation: number
  startsRequest: boolean
}

/** Monotonic request ownership independent of ArkUI promise timing. */
export class DMPOrientationRequestLedger {
  private generation: number = 0
  private orientation: window.Orientation | undefined

  claim(orientation: window.Orientation): DMPOrientationRequestClaim {
    if (this.orientation === orientation) {
      return { generation: this.generation, startsRequest: false }
    }
    this.orientation = orientation
    this.generation += 1
    return { generation: this.generation, startsRequest: true }
  }

  requestsNewOrientation(orientation: window.Orientation): boolean {
    return this.orientation !== orientation
  }

  /**
   * Restoration debt begins when a mini-program request is accepted by this scheduler, not when
   * ArkUI's promise eventually resolves. Otherwise an owner that disappears during its first
   * in-flight request can leave the host locked after that late request succeeds.
   */
  needsHostRestoration(
    hasAppliedOrientation: boolean,
    hostOrientation: window.Orientation
  ): boolean {
    return hasAppliedOrientation ||
      (this.orientation !== undefined && this.orientation !== hostOrientation)
  }

  isLatest(generation: number): boolean {
    return generation === this.generation
  }

  invalidate(generation: number, orientation: window.Orientation): void {
    if (this.isLatest(generation) && this.orientation === orientation) {
      this.orientation = undefined
    }
  }

  release(): void {
    this.orientation = undefined
    this.generation += 1
  }
}

export class DMPDeviceUtil {
  private static safeAreaAndDisplayWHCache: DMPMap | undefined
  private static observedWindow: window.Window | undefined
  private static metricsChangeCallbacks: DMPDeviceMetricsChangeCallback[] = []
  // 已完成的系统请求形成恢复债务；尚未完成的请求由 orientationLedger 的当前 intent 形成债务。
  private static hasAppliedOrientation = false
  private static orientationLedger: DMPOrientationRequestLedger = new DMPOrientationRequestLedger()
  private static pendingOrientationRequest: DMPPendingOrientationRequest | undefined

  private static readonly windowSizeChangeCallback = (_size: window.Size): void => {
    DMPDeviceUtil.refreshObservedWindowMetrics()
  }

  private static readonly avoidAreaChangeCallback = (_options: window.AvoidAreaOptions): void => {
    DMPDeviceUtil.refreshObservedWindowMetrics()
  }

  // 同步方法，此方法依赖 prepareSafeAreaAndDisplayWH 提前调用
  static getSafeAreaAndDisplayWHSync(): DMPMap {
    if (!DMPDeviceUtil.safeAreaAndDisplayWHCache) {
      DMPDeviceUtil.safeAreaAndDisplayWHCache = DMPDeviceUtil.buildFallbackMetrics()
    }
    return DMPDeviceUtil.safeAreaAndDisplayWHCache
  }

  static async prepareSafeAreaAndDisplayWH(context: Context): Promise<DMPMap> {
    try {
      const windowClass: window.Window = await window.getLastWindow(context)
      DMPDeviceUtil.observeWindow(windowClass)
      return DMPDeviceUtil.refreshWindowMetrics(windowClass, true)
    } catch (_) {
      return DMPDeviceUtil.safeAreaAndDisplayWHCache ?? DMPDeviceUtil.buildFallbackMetrics()
    }
  }

  static prepareSafeAreaAndDisplayWHForWindow(windowClass: window.Window): DMPMap {
    DMPDeviceUtil.observeWindow(windowClass)
    return DMPDeviceUtil.refreshWindowMetrics(windowClass, false)
  }

  static addMetricsChangeListener(callback: DMPDeviceMetricsChangeCallback): void {
    if (DMPDeviceUtil.metricsChangeCallbacks.indexOf(callback) < 0) {
      DMPDeviceUtil.metricsChangeCallbacks.push(callback)
    }
  }

  static removeMetricsChangeListener(callback: DMPDeviceMetricsChangeCallback): void {
    const index: number = DMPDeviceUtil.metricsChangeCallbacks.indexOf(callback)
    if (index >= 0) {
      DMPDeviceUtil.metricsChangeCallbacks.splice(index, 1)
    }
  }

  /**
   * WindowStage 销毁时解除共享窗口订阅并同步推到新世代。
   * 窗口对象已经终止，不能等待它再发一条 destroyed/size-change 事件反推终态；迟到的方向请求结果会因世代不匹配静默失效。
   * 下一次 init 会从新窗口重新建立几何与方向权威。
   */
  static releaseWindowObservation(): void {
    if (DMPDeviceUtil.observedWindow) {
      try {
        DMPDeviceUtil.observedWindow.off('windowSizeChange', DMPDeviceUtil.windowSizeChangeCallback)
        DMPDeviceUtil.observedWindow.off('avoidAreaChange', DMPDeviceUtil.avoidAreaChangeCallback)
      } catch (_) {
      }
    }
    DMPDeviceUtil.observedWindow = undefined
    DMPDeviceUtil.safeAreaAndDisplayWHCache = undefined
    DMPDeviceUtil.orientationLedger.release()
    DMPDeviceUtil.pendingOrientationRequest = undefined
    DMPDeviceUtil.hasAppliedOrientation = false
  }

  /**
   * The single preferred-orientation scheduler.
   * Identical callers join one in-flight request and share its generation; only a different orientation supersedes it.
   * Results carry generation so callers can make stale completion inert without cancelling the platform promise.
   */
  static async applyPreferredOrientation(
    orientation: window.Orientation
  ): Promise<DMPOrientationRequestResult> {
    const observedWindow = DMPDeviceUtil.observedWindow
    if (!observedWindow) {
      return {
        generation: DMPDeviceUtil.orientationLedger.claim(orientation).generation,
        error: new Error('window unavailable')
      }
    }

    const claim = DMPDeviceUtil.orientationLedger.claim(orientation)
    if (!claim.startsRequest) {
      const pending = DMPDeviceUtil.pendingOrientationRequest
      if (pending?.orientation === orientation) {
        return pending.promise
      }
      return { generation: claim.generation }
    }

    const generation = claim.generation
    const previous = DMPDeviceUtil.pendingOrientationRequest?.promise
    const promise = previous
      ? previous.then(() => DMPDeviceUtil.performOrientationRequest(observedWindow, orientation, generation))
      : DMPDeviceUtil.performOrientationRequest(observedWindow, orientation, generation)

    DMPDeviceUtil.pendingOrientationRequest = { orientation: orientation, promise: promise }
    const result = await promise
    if (DMPDeviceUtil.pendingOrientationRequest?.promise === promise) {
      DMPDeviceUtil.pendingOrientationRequest = undefined
    }
    return result
  }

  private static async performOrientationRequest(
    observedWindow: window.Window,
    orientation: window.Orientation,
    generation: number
  ): Promise<DMPOrientationRequestResult> {
    // A queued request superseded before reaching the platform has no side effects.
    if (!DMPDeviceUtil.orientationLedger.isLatest(generation)) {
      return { generation: generation }
    }
    try {
      await observedWindow.setPreferredOrientation(orientation)
      // Only an accepted request on the current owner creates host-restoration debt.
      if (DMPDeviceUtil.observedWindow === observedWindow) {
        DMPDeviceUtil.hasAppliedOrientation = true
      }
      return { generation: generation }
    } catch (err) {
      return { generation: generation, error: err as Error }
    }
  }

  /**
   * 窗口现在是不是整屏——也就是一次方向请求还能不能真的把它转过来。
   *
   * 分屏、悬浮窗、自由窗口下 setPreferredOrientation 会被受理却不改变窗口方向，押着等转屏的 pageShow 就再也没有放行者。
   * 只在**确实读到** FULL_SCREEN 时才算证明成立：读不到（旧设备没有这个接口、窗口还没建立）不是证明，宁可不押后——代价只是 onShow 读到的还是当前几何，而那正是窗口不会转时它会一直保持的几何。
   */
  static windowCanRotate(): boolean {
    const observed = DMPDeviceUtil.observedWindow
    if (!observed) {
      return false
    }
    try {
      return observed.getWindowStatus() === window.WindowStatusType.FULL_SCREEN
    } catch (err) {
      console.warn(`[dimina] getWindowStatus unavailable: ${(err as Error).message}`)
      return false
    }
  }

  /** True until the current orientation's shared platform request has settled. */
  static requestsNewOrientation(orientation: window.Orientation): boolean {
    if (!DMPDeviceUtil.observedWindow) {
      return false
    }
    const pending = DMPDeviceUtil.pendingOrientationRequest
    if (pending?.orientation === orientation) {
      return true
    }
    return DMPDeviceUtil.orientationLedger.requestsNewOrientation(orientation)
  }

  /**
   * 最后一个小程序退出时把窗口方向还给宿主：从未有小程序改过窗口方向时什么也不做（没碰过就无需恢复）；碰过至少一次时恢复成 UNSPECIFIED，把窗口方向交还给系统/宿主 ability 自身的配置决定。
   */
  static async restoreHostOrientation(): Promise<void> {
    const orientation = window.Orientation.UNSPECIFIED
    if (!DMPDeviceUtil.observedWindow ||
      !DMPDeviceUtil.orientationLedger.needsHostRestoration(
        DMPDeviceUtil.hasAppliedOrientation,
        orientation
      )) {
      return
    }
    // Restoration uses the same scheduler as pages.
    // A new app can supersede this request while it is in flight; the late restoration result then cannot clear the new owner's restoration debt.
    const result = await DMPDeviceUtil.applyPreferredOrientation(orientation)
    if (result.error) {
      DMPDeviceUtil.invalidateFailedOrientationRequest(result.generation, orientation)
      return
    }
    if (DMPDeviceUtil.isLatestOrientationGeneration(result.generation)) {
      DMPDeviceUtil.hasAppliedOrientation = false
    }
  }

  /**
   * Generation filters request completions only.
   * ArkUI geometry events have no request correlation ID, so assigning them by arrival order would lose real rotations whenever a request emits no geometry event.
   */
  static isLatestOrientationGeneration(generation: number): boolean {
    return DMPDeviceUtil.orientationLedger.isLatest(generation)
  }

  /** A rejected current request must be retryable; superseded failures cannot alter newer state. */
  static invalidateFailedOrientationRequest(
    generation: number,
    orientation: window.Orientation
  ): void {
    DMPDeviceUtil.orientationLedger.invalidate(generation, orientation)
  }

  private static observeWindow(windowClass: window.Window): void {
    if (DMPDeviceUtil.observedWindow === windowClass) {
      return
    }

    if (DMPDeviceUtil.observedWindow) {
      try {
        DMPDeviceUtil.observedWindow.off('windowSizeChange', DMPDeviceUtil.windowSizeChangeCallback)
        DMPDeviceUtil.observedWindow.off('avoidAreaChange', DMPDeviceUtil.avoidAreaChangeCallback)
      } catch (_) {
      }
      // A new Window is a new owner. Requests tied to the old owner must not be reused or revive it.
      DMPDeviceUtil.orientationLedger.release()
      DMPDeviceUtil.pendingOrientationRequest = undefined
      DMPDeviceUtil.hasAppliedOrientation = false
    }

    DMPDeviceUtil.observedWindow = windowClass
    try {
      windowClass.on('windowSizeChange', DMPDeviceUtil.windowSizeChangeCallback)
      windowClass.on('avoidAreaChange', DMPDeviceUtil.avoidAreaChangeCallback)
    } catch (_) {
    }
  }

  private static refreshObservedWindowMetrics(): void {
    if (DMPDeviceUtil.observedWindow) {
      DMPDeviceUtil.refreshWindowMetrics(DMPDeviceUtil.observedWindow, true)
    }
  }

  private static refreshWindowMetrics(windowClass: window.Window, notify: boolean): DMPMap {
    const result: DMPMap = DMPDeviceUtil.buildWindowMetrics(windowClass)
    DMPDeviceUtil.safeAreaAndDisplayWHCache = result

    if (notify) {
      DMPDeviceUtil.metricsChangeCallbacks.slice().forEach((callback: DMPDeviceMetricsChangeCallback) => {
        try {
          callback(result)
        } catch (_) {
        }
      })
    }
    return result
  }

  private static buildWindowMetrics(windowClass: window.Window): DMPMap {
    try {
      const properties: window.WindowProperties = windowClass.getWindowProperties()
      const windowRect: window.Rect = properties.windowRect
      let displayInfo: display.Display
      try {
        displayInfo = properties.displayId !== undefined ?
          display.getDisplayByIdSync(properties.displayId) : display.getDefaultDisplaySync()
      } catch (_) {
        displayInfo = display.getDefaultDisplaySync()
      }

      let systemArea: window.AvoidArea | undefined = undefined
      let navigationArea: window.AvoidArea | undefined = undefined
      try {
        systemArea = windowClass.getWindowAvoidArea(window.AvoidAreaType.TYPE_SYSTEM)
      } catch (_) {
      }
      try {
        navigationArea = windowClass.getWindowAvoidArea(window.AvoidAreaType.TYPE_NAVIGATION_INDICATOR)
      } catch (_) {
      }

      const leftInsetPx: number = Math.max(systemArea?.leftRect.width ?? 0, navigationArea?.leftRect.width ?? 0)
      const rightInsetPx: number = Math.max(systemArea?.rightRect.width ?? 0, navigationArea?.rightRect.width ?? 0)
      const topInsetPx: number = Math.max(systemArea?.topRect.height ?? 0, navigationArea?.topRect.height ?? 0)
      const bottomInsetPx: number = Math.max(systemArea?.bottomRect.height ?? 0,
        navigationArea?.bottomRect.height ?? 0)

      return DMPDeviceUtil.buildMetrics(
        displayInfo,
        windowRect.width,
        windowRect.height,
        leftInsetPx,
        rightInsetPx,
        topInsetPx,
        bottomInsetPx
      )
    } catch (_) {
      return DMPDeviceUtil.safeAreaAndDisplayWHCache ?? DMPDeviceUtil.buildFallbackMetrics()
    }
  }

  private static buildFallbackMetrics(): DMPMap {
    try {
      const displayInfo: display.Display = display.getDefaultDisplaySync()
      return DMPDeviceUtil.buildMetrics(displayInfo, displayInfo.width, displayInfo.height, 0, 0, 0, 0)
    } catch (_) {
      return new DMPMap({
        safeArea: new DMPMap({ right: 0, bottom: 0, left: 0, top: 0, width: 0, height: 0 }),
        screenWidth: 0,
        screenHeight: 0,
        windowWidth: 0,
        windowHeight: 0,
        statusBarHeight: 0,
        navigationHeight: 0,
        pixelRatio: 1,
        deviceOrientation: 'portrait'
      })
    }
  }

  private static buildMetrics(displayInfo: display.Display, windowWidthPx: number, windowHeightPx: number,
    leftInsetPx: number, rightInsetPx: number, topInsetPx: number, bottomInsetPx: number): DMPMap {
    const density: number = displayInfo.densityPixels > 0 ? displayInfo.densityPixels : 1
    const screenWidth: number = Math.round(displayInfo.width / density)
    const screenHeight: number = Math.round(displayInfo.height / density)
    const windowWidth: number = Math.round(windowWidthPx / density)
    const fullWindowHeight: number = Math.round(windowHeightPx / density)
    const left: number = Math.ceil(leftInsetPx / density)
    const rightInset: number = Math.ceil(rightInsetPx / density)
    const top: number = Math.ceil(topInsetPx / density)
    const bottomInset: number = Math.ceil(bottomInsetPx / density)
    const right: number = Math.max(windowWidth - rightInset, left)
    const bottom: number = Math.max(fullWindowHeight - bottomInset, top)
    // 界面方向而非传感器物理方向：displayInfo.orientation 是系统实际渲染内容所用的方向（受旋转锁与 app 自身的 preferred orientation 约束），平放或锁死时也如实反映
    const deviceOrientation: string =
      displayInfo.orientation === display.Orientation.LANDSCAPE ||
        displayInfo.orientation === display.Orientation.LANDSCAPE_INVERTED
        ? 'landscape' : 'portrait'

    return new DMPMap({
      safeArea: new DMPMap({
        right: right,
        bottom: bottom,
        left: left,
        top: top,
        width: Math.max(right - left, 0),
        height: Math.max(bottom - top, 0)
      }),
      screenWidth: screenWidth,
      screenHeight: screenHeight,
      windowWidth: windowWidth,
      windowHeight: Math.max(fullWindowHeight - top - bottomInset, 0),
      statusBarHeight: top,
      navigationHeight: bottomInset,
      pixelRatio: density,
      deviceOrientation: deviceOrientation
    })
  }
}
