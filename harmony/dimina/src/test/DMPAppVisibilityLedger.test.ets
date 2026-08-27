import { describe, expect, it } from '@ohos/hypium'
import { DMPAppVisibilityLedger } from '../main/ets/DApp/utils/DMPAppVisibilityLedger'

export default function dmpAppVisibilityLedgerTest() {
  describe('DMPAppVisibilityLedger', () => {
    it('holdsBackTheHideThatArrivesBeforeTheRuntimeIsReady', 0, () => {
      const ledger = new DMPAppVisibilityLedger()

      // 跨小程序打开的目标已经是展示栈顶，但 logic.js 还没跑起来：此刻派发就整条丢了。
      expect(ledger.request(false)).assertFalse()
      expect(ledger.markServiceReady()).assertTrue()
      // 补发过一次之后不再重复。
      expect(ledger.markServiceReady()).assertFalse()
    })

    it('dropsAWindowHideThatIsUndoneBeforeTheRuntimeIsReady', 0, () => {
      const ledger = new DMPAppVisibilityLedger()

      expect(ledger.request(false)).assertFalse()
      expect(ledger.request(true)).assertFalse()
      // 一进一出净变化为零，新运行时自己会派发 onLaunch/onShow，不该再补一条。
      expect(ledger.markServiceReady()).assertFalse()
    })

    it('keepsAppShowAndAppHideStrictlyAlternating', 0, () => {
      const ledger = new DMPAppVisibilityLedger()
      ledger.markServiceReady()

      // 启动即已显示，重复的 show 不派发。
      expect(ledger.request(true)).assertFalse()
      expect(ledger.request(false)).assertTrue()
      // 退出已经派发过 hide，紧接着系统进后台不再派发第二条。
      expect(ledger.request(false)).assertFalse()
      expect(ledger.request(true)).assertTrue()
    })

    it('keepsTheVisibleBaselineWhenOnlyTheRuntimeIsReplaced', 0, () => {
      const ledger = new DMPAppVisibilityLedger()
      ledger.markServiceReady()

      // restart：这条 hide 是发给旧 Worker 的终态，容器并没有隐藏。
      expect(ledger.requestRuntimeTeardownHide()).assertTrue()
      ledger.markRuntimeReplaced()

      // 新 Worker 自带一次 onShow，账本回到「已显示且已送达」，不欠补发。
      expect(ledger.markServiceReady()).assertFalse()
      expect(ledger.request(true)).assertFalse()
      expect(ledger.request(false)).assertTrue()
    })

    it('carriesASystemBackgroundAcrossARuntimeRestart', 0, () => {
      const ledger = new DMPAppVisibilityLedger()
      ledger.markServiceReady()
      expect(ledger.requestRuntimeTeardownHide()).assertTrue()

      // 旧 Worker 正在销毁时按下 Home：只记账，不投递给将死的运行时。
      expect(ledger.request(false)).assertFalse()
      ledger.markRuntimeReplaced()

      // 新运行时就绪时补上真实的后台状态，而不是以为自己在前台。
      expect(ledger.markServiceReady()).assertTrue()
      expect(ledger.request(true)).assertTrue()
    })

    it('doesNotRepeatTheHideWhenTheRuntimeIsReplacedWhileHidden', 0, () => {
      const ledger = new DMPAppVisibilityLedger()
      ledger.markServiceReady()
      expect(ledger.request(false)).assertTrue()

      // 已经隐藏过，销毁时不再重复一条 appHide。
      expect(ledger.requestRuntimeTeardownHide()).assertFalse()
      ledger.markRuntimeReplaced()

      // 容器仍在后台，新运行时必须知道。
      expect(ledger.markServiceReady()).assertTrue()
    })

    it('restoresTheVisibleBaselineWhenTheAppRelaunchesAfterExit', 0, () => {
      const ledger = new DMPAppVisibilityLedger()
      ledger.markServiceReady()
      // 退出：容器真的隐藏了。
      expect(ledger.request(false)).assertTrue()

      ledger.markRuntimeRelaunched()

      // 重新展示，新 Worker 自带 onShow，不该再补一条 appHide。
      expect(ledger.markServiceReady()).assertFalse()
      expect(ledger.request(false)).assertTrue()
    })
  })
}
