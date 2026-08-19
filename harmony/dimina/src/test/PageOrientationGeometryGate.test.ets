import { describe, it, expect } from '@ohos/hypium'
import { window } from '@kit.ArkUI'
import { DMPPageOrientation } from '../main/ets/DPages/DMPPageOrientation'
import { DMPPageOrientationCapability } from '../main/ets/DPages/DMPPageOrientationCapability'
import { DMPPageLifecycle, DMPPageShowLedger } from '../main/ets/DPages/DMPPageLifecycle'
import { DMPOrientationRequestLedger } from '../main/ets/Utils/DMPDeviceUtils'
import { DMPForegroundAppLedger } from '../main/ets/DApp/DMPAppManager'
import { hasTabBarContext } from '../main/ets/Navigator/DMPNavigator'

export default function pageOrientationGeometryGateTest() {
  describe('DMPPageOrientationCapability', () => {
    it('keepsExistingHostsDisabledUnlessTheyExplicitlyOptIn', 0, () => {
      expect(DMPPageOrientationCapability.isEnabled(undefined)).assertFalse()
      expect(DMPPageOrientationCapability.isEnabled(false)).assertFalse()
      expect(DMPPageOrientationCapability.isEnabled(true)).assertTrue()
    })
  })

  describe('DMPPageOrientation.resolveConfig', () => {
    it('fallsThroughInvalidPageValuesAndDefaultsToPortrait', 0, () => {
      expect(DMPPageOrientation.resolveConfig('invalid', 'landscape')).assertEqual('landscape')
      expect(DMPPageOrientation.resolveConfig(undefined, undefined)).assertEqual('portrait')
    })
  })

  describe('DMPPageOrientation.toWindowOrientation', () => {
    it('keepsBothLandscapeDirectionsAvailableWithoutTheRotationLock', 0, () => {
      expect(DMPPageOrientation.toWindowOrientation('landscape'))
        .assertEqual(window.Orientation.AUTO_ROTATION_LANDSCAPE)
    })

    it('respectsTheRotationLockOnlyForAutoPages', 0, () => {
      expect(DMPPageOrientation.toWindowOrientation('auto'))
        .assertEqual(window.Orientation.AUTO_ROTATION_RESTRICTED)
      expect(DMPPageOrientation.toWindowOrientation('portrait'))
        .assertEqual(window.Orientation.PORTRAIT)
    })
  })

  describe('DMPOrientationRequestLedger', () => {
    it('coalescesTheSameInFlightOrientationWithoutSupersedingItsGeneration', 0, () => {
      const ledger = new DMPOrientationRequestLedger()
      const first = ledger.claim(window.Orientation.AUTO_ROTATION_LANDSCAPE)
      const joined = ledger.claim(window.Orientation.AUTO_ROTATION_LANDSCAPE)

      expect(first.startsRequest).assertTrue()
      expect(joined.startsRequest).assertFalse()
      expect(joined.generation).assertEqual(first.generation)
      expect(ledger.isLatest(first.generation)).assertTrue()
    })

    it('makesOldOwnerResultsStaleAndReissuesTheSameOrientationForANewOwner', 0, () => {
      const ledger = new DMPOrientationRequestLedger()
      const oldOwner = ledger.claim(window.Orientation.AUTO_ROTATION_LANDSCAPE)

      ledger.release()
      const newOwner = ledger.claim(window.Orientation.AUTO_ROTATION_LANDSCAPE)

      expect(ledger.isLatest(oldOwner.generation)).assertFalse()
      expect(newOwner.startsRequest).assertTrue()
      expect(ledger.isLatest(newOwner.generation)).assertTrue()
    })

    it('onlyLetsTheCurrentFailureInvalidateTheRequestedOrientation', 0, () => {
      const ledger = new DMPOrientationRequestLedger()
      const stale = ledger.claim(window.Orientation.AUTO_ROTATION_LANDSCAPE)
      const current = ledger.claim(window.Orientation.PORTRAIT)

      ledger.invalidate(stale.generation, window.Orientation.AUTO_ROTATION_LANDSCAPE)
      expect(ledger.requestsNewOrientation(window.Orientation.PORTRAIT)).assertFalse()

      ledger.invalidate(current.generation, window.Orientation.PORTRAIT)
      expect(ledger.requestsNewOrientation(window.Orientation.PORTRAIT)).assertTrue()
    })
  })

  describe('DMPPageShowLedger', () => {
    it('dropsTheOldPageShowAndOnlyConsumesTheCurrentGeometry', 0, () => {
      const ledger = new DMPPageShowLedger()
      const oldGeneration = ledger.claim(1)
      const currentGeneration = ledger.claim(2)

      expect(ledger.take(1, oldGeneration)).assertFalse()
      expect(ledger.take(2, currentGeneration)).assertTrue()
      expect(ledger.take(2, currentGeneration)).assertFalse()
    })

    it('reportsAPageShowAsPendingOnlyUntilSomethingConsumesIt', 0, () => {
      // 兜底放行要先问「这次 pageShow 还挂着吗」再补 reportResize，否则已经由窗口回调放行过的页面会被多报一次 resize。
      const ledger = new DMPPageShowLedger()
      const generation = ledger.claim(7)

      expect(ledger.isPending(7, generation)).assertTrue()
      expect(ledger.isPending(8, generation)).assertFalse()
      ledger.take(7, generation)
      expect(ledger.isPending(7, generation)).assertFalse()
    })
  })

  describe('DMPPageOrientation.defersPageShow', () => {
    it('waitsOnlyWhenAFixedPageIsAboutToChangeTheWindowDirection', 0, () => {
      expect(DMPPageOrientation.defersPageShow('landscape', 'portrait')).assertEqual(true)
      expect(DMPPageOrientation.defersPageShow('portrait', 'landscape')).assertEqual(true)
    })

    it('showsAFixedPageThatAlreadyHasItsDirectionWithoutWaiting', 0, () => {
      expect(DMPPageOrientation.defersPageShow('landscape', 'landscape')).assertEqual(false)
      expect(DMPPageOrientation.defersPageShow('portrait', 'portrait')).assertEqual(false)
    })

    it('neverBlocksAnAutoPageOnAGeometryEventThatMayNeverArrive', 0, () => {
      // auto 请求的是「跟随传感器」：设备本来就处在传感器方向时窗口不会变，也就不会有任何回调来放行 pageShow。
      // 等下去等于这一页永远收不到 onShow。
      expect(DMPPageOrientation.defersPageShow('auto', 'portrait')).assertEqual(false)
      expect(DMPPageOrientation.defersPageShow('auto', 'landscape')).assertEqual(false)
    })
  })

  describe('DMPForegroundAppLedger', () => {
    it('keepsTheAppInForegroundWhileAnyOfItsPagesIsStillVisible', 0, () => {
      // 同一个 app 内部换页：新页 onShown 与旧页 onHidden 的先后没有保证，两种顺序都不能把「这个 app 还在前台」清掉，否则之后的几何上报全部停摆。
      const shownFirst = new DMPForegroundAppLedger()
      shownFirst.pageShown(1)
      shownFirst.pageShown(1)
      shownFirst.pageHidden(1)
      expect(shownFirst.isForeground(1)).assertTrue()

      const hiddenFirst = new DMPForegroundAppLedger()
      hiddenFirst.pageShown(1)
      hiddenFirst.pageHidden(1)
      hiddenFirst.pageShown(1)
      expect(hiddenFirst.isForeground(1)).assertTrue()
    })

    it('handsTheWindowBackWhenTheAppsLastVisiblePageIsCovered', 0, () => {
      // 宿主页面盖住整个小程序：它不再拥有窗口，几何变化不该再送到它手上，也不该由它把自己的方向重新按到窗口上。
      const ledger = new DMPForegroundAppLedger()
      ledger.pageShown(1)

      ledger.pageHidden(1)

      expect(ledger.isForeground(1)).assertFalse()
      expect(ledger.currentIndex()).assertEqual(-1)
    })

    it('leavesTheNewOwnerAloneWhenTheCoveredAppFinallyReportsItsPageHidden', 0, () => {
      // app B 盖住 app A：A 的 onHidden 可能晚于 B 的 onShown 到达，它只能清自己的账，不能把已经接管窗口的 B 清掉。
      const ledger = new DMPForegroundAppLedger()
      ledger.pageShown(1)
      ledger.pageShown(2)

      ledger.pageHidden(1)

      expect(ledger.isForeground(2)).assertTrue()
    })

    it('takesTheUnownedWindowSoTheFirstPageIsNotBlindToItsOnlyGeometryCallback', 0, () => {
      // 导航先同步跑 DMPPageLifecycle.onShow，ArkUI 的 onShown 要到下一帧才到——这段空窗里账本还是空的，冷启动第一页押出去的 pageShow 只能靠窗口几何回调放行，而那个回调按归属过滤，无主时会被整个丢掉。
      const ledger = new DMPForegroundAppLedger()

      ledger.claimIfUnowned(1)

      expect(ledger.isForeground(1)).assertTrue()
    })

    it('neverTakesTheWindowFromTheAppWhosePagesAreActuallyOnScreen', 0, () => {
      // 认领只补「无主」这一种情形。
      // 后台 app 自己发起换页（定时器里的 navigateTo）同样会走 onShow，它不能把归属从屏幕上真实可见的那个 app 手里抢走。
      const ledger = new DMPForegroundAppLedger()
      ledger.pageShown(1)

      ledger.claimIfUnowned(2)

      expect(ledger.isForeground(1)).assertTrue()
      expect(ledger.isForeground(2)).assertFalse()
    })

    it('stillHandsTheWindowBackThroughTheVisiblePageCountAfterAClaim', 0, () => {
      // 认领不记可见页计数，交还窗口的路径必须还是原来那条：onShown 记一笔、onHidden 归零。
      const ledger = new DMPForegroundAppLedger()
      ledger.claimIfUnowned(1)

      ledger.pageShown(1)
      ledger.pageHidden(1)

      expect(ledger.isForeground(1)).assertFalse()
      expect(ledger.currentIndex()).assertEqual(-1)
    })

    it('dropsTheLedgerOfAnExitedAppWithoutWaitingForItsPagesToReportHidden', 0, () => {
      const ledger = new DMPForegroundAppLedger()
      ledger.pageShown(1)
      ledger.pageShown(1)

      ledger.release(1)

      expect(ledger.isForeground(1)).assertFalse()
      // 退出后再冒出来的一次 onHidden 不能让计数变成负数，进而让重开的同一个 app 第一次 onShown 之后仍然差一次 hidden 才归零
      ledger.pageHidden(1)
      ledger.pageShown(1)
      ledger.pageHidden(1)
      expect(ledger.isForeground(1)).assertFalse()
    })
  })

  describe('DMPPageOrientation.dispatchesResize', () => {
    it('neverCountsTheWindowsFirstLayoutAsAResize', 0, () => {
      expect(DMPPageOrientation.dispatchesResize('', '377x749@portrait')).assertFalse()
    })

    it('reportsARealGeometryChange', 0, () => {
      expect(DMPPageOrientation.dispatchesResize('816x349@landscape', '377x749@portrait')).assertTrue()
    })

    it('staysSilentWhenAWindowEventDidNotMoveTheWindow', 0, () => {
      // 键盘收起、状态栏显隐与窗口尺寸变化订阅在同一个入口上。
      // 窗口没动的那些事件不该变成一次 resize——这条判据只管窗口通道那一侧，路由落地那条上报不走它。
      expect(DMPPageOrientation.dispatchesResize('377x749@portrait', '377x749@portrait')).assertFalse()
    })

    it('treatsTheDeviceOrientationAsPartOfTheGeometry', 0, () => {
      // 正方形窗口或分屏下宽高可能不变而方向变了，方向必须参与比较，否则这次变化被吞掉。
      expect(DMPPageOrientation.dispatchesResize('500x500@portrait', '500x500@landscape')).assertTrue()
    })
  })

  describe('Harmony switchTab context', () => {
    it('requiresRelaunchWhenAColdNonTabEntryHasNoTabContainer', 0, () => {
      const tabPaths: Set<string> = new Set(['pages/tab-a/index', 'pages/tab-b/index'])
      expect(hasTabBarContext(['pages/non-tab/index'], tabPaths)).assertFalse()
      expect(hasTabBarContext(['pages/tab-a/index', 'pages/detail/index'], tabPaths)).assertTrue()
    })
  })

  describe('orientation request generation', () => {
    it('dropsSupersededFailuresAndPropagatesTheCurrentFailure', 0, () => {
      const error = new Error('rejected')

      expect(DMPPageLifecycle.settleOrientationRequest(false, error)).assertFalse()

      let propagated = false
      try {
        DMPPageLifecycle.settleOrientationRequest(true, error)
      } catch (_) {
        propagated = true
      }
      expect(propagated).assertTrue()
      expect(DMPPageLifecycle.settleOrientationRequest(true)).assertTrue()
    })
  })

  describe('DMPPageOrientation.isGeometrySettled', () => {
    it('withholdsTheLandscapeGeometryAnAutoPageIsAboutToLose', 0, () => {
      // 从固定横屏页返回 auto 页：onShow 早于 applyOrientation，窗口还是横的，紧接着就会被请求成 AUTO 转回竖屏。
      // 此刻读到的 landscape 这一页从未渲染过，不能上报。
      expect(DMPPageOrientation.isGeometrySettled('auto', true, 'landscape')).assertEqual(false)
    })

    it('reportsLandscapeForAnAutoPageWhenNoNewOrientationIsRequested', 0, () => {
      // 同为 auto 的两页之间返回、或设备在本页隐藏期间真的转了：窗口方向不会被重新请求，横屏就是这一页接下来会保持的几何，必须照常上报，不能因为「上一次是竖屏」就吞掉。
      expect(DMPPageOrientation.isGeometrySettled('auto', false, 'landscape')).assertEqual(true)
    })

    it('reportsPortraitForAnAutoPageWhenNoNewOrientationIsRequested', 0, () => {
      expect(DMPPageOrientation.isGeometrySettled('auto', false, 'portrait')).assertEqual(true)
    })

    it('withholdsGeometryWhileAFixedOrientationPageIsStillRequestingItsOrientation', 0, () => {
      expect(DMPPageOrientation.isGeometrySettled('landscape', true, 'portrait')).assertEqual(false)
    })

    it('withholdsGeometryWhileAnEarlierRequestForTheSameOrientationIsStillInFlight', 0, () => {
      // 连续两次进入固定横屏页时，第二页解算出的方向与已请求的相同（不会再请求一次），但上一次请求引起的重新布局还没落地——deviceOrientation 仍是竖的就是证据。
      expect(DMPPageOrientation.isGeometrySettled('landscape', false, 'portrait')).assertEqual(false)
    })

    it('reportsGeometryOnceAFixedOrientationPageHasTheOrientationItAskedFor', 0, () => {
      expect(DMPPageOrientation.isGeometrySettled('landscape', false, 'landscape')).assertEqual(true)
      expect(DMPPageOrientation.isGeometrySettled('portrait', false, 'portrait')).assertEqual(true)
    })

    it('doesNotWaitForAnIdempotentFixedDirectionRequestThatEmitsNoMetricsEvent', 0, () => {
      expect(DMPPageOrientation.isGeometrySettled('portrait', true, 'portrait')).assertEqual(true)
      expect(DMPPageOrientation.isGeometrySettled('landscape', true, 'landscape')).assertEqual(true)
    })

    it('withholdsGeometryForAPortraitPageStillShowingTheLandscapeItIsLeaving', 0, () => {
      expect(DMPPageOrientation.isGeometrySettled('portrait', true, 'landscape')).assertEqual(false)
      expect(DMPPageOrientation.isGeometrySettled('portrait', false, 'landscape')).assertEqual(false)
    })
  })

  describe('DMPPageOrientation.releasesPendingPageShow', () => {
    it('holdsThePageShowWhileTheWindowIsStillOnItsWayToTheRequestedAxis', 0, () => {
      expect(DMPPageOrientation.releasesPendingPageShow(false, true)).assertEqual(false)
    })

    it('releasesAsSoonAsTheGeometryLands', 0, () => {
      expect(DMPPageOrientation.releasesPendingPageShow(true, true)).assertEqual(true)
    })

    it('releasesWhenTheProofThatTheWindowWillTurnStopsHolding', 0, () => {
      // 押后的前提只在 onShow 那一刻取过一次。
      // 请求在途中窗口被拖进分屏/悬浮窗后平台受理方向请求却不转窗口，几何永远不会落地——只判 settled 的话这条 pageShow 没有放行者。
      expect(DMPPageOrientation.releasesPendingPageShow(false, false)).assertEqual(true)
    })
  })
}
