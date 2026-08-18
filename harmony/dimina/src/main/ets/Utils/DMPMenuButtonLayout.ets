import { DMPMap } from './DMPMap'

/**
 * Native capsule layout tokens shared by the page chrome and the JS API.
 * All values use vp, matching mini-program logical pixels on HarmonyOS.
 */
export class DMPMenuButtonLayout {
  static readonly capsuleWidth: number = 87
  static readonly capsuleHeight: number = 32
  static readonly trailingSpacing: number = 10
  static readonly navigationBarContentHeight: number = 55
  static readonly titleTrailingGap: number = 13
  static readonly titleHorizontalInset: number = DMPMenuButtonLayout.trailingSpacing +
    DMPMenuButtonLayout.capsuleWidth + DMPMenuButtonLayout.titleTrailingGap

  static buildRect(windowWidth: number, statusBarHeight: number): DMPMap {
    const top: number = statusBarHeight +
      Math.round((DMPMenuButtonLayout.navigationBarContentHeight - DMPMenuButtonLayout.capsuleHeight) / 2)
    const right: number = Math.max(windowWidth - DMPMenuButtonLayout.trailingSpacing,
      DMPMenuButtonLayout.capsuleWidth)
    const left: number = right - DMPMenuButtonLayout.capsuleWidth
    const bottom: number = top + DMPMenuButtonLayout.capsuleHeight

    return new DMPMap({
      top: top,
      left: left,
      width: DMPMenuButtonLayout.capsuleWidth,
      height: DMPMenuButtonLayout.capsuleHeight,
      bottom: bottom,
      right: right,
      x: left,
      y: top
    })
  }

  static buildFromWindowMetrics(metrics: DMPMap): DMPMap {
    return DMPMenuButtonLayout.buildRect(
      (metrics.get('windowWidth') as number) ?? 0,
      (metrics.get('statusBarHeight') as number) ?? 0
    )
  }
}
