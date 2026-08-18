import { DMPMap } from './DMPMap'
import { display, window } from '@kit.ArkUI'

export type DMPDeviceMetricsChangeCallback = (metrics: DMPMap) => void

export class DMPDeviceUtil {
  private static safeAreaAndDisplayWHCache: DMPMap | undefined
  private static observedWindow: window.Window | undefined
  private static metricsChangeCallbacks: DMPDeviceMetricsChangeCallback[] = []

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
        pixelRatio: 1
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
      pixelRatio: density
    })
  }
}
