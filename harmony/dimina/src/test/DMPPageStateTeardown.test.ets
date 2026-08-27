import { describe, expect, it } from '@ohos/hypium'
import { dispatchesPageUnload, DMPPageStateTeardown } from '../main/ets/Navigator/DMPPageStateTeardown'

export default function dmpPageStateTeardownTest() {
  describe('DMPPageStateTeardown', () => {
    it('routingTeardownUnloadsThePages', 0, () => {
      // 微信的 unloadPage 只由路由事件驱动（reLaunch/redirectTo/navigateBack/switchTab），
      // 这些页面确实被路由销毁，JS 侧必须收到 onUnload。
      expect(dispatchesPageUnload(DMPPageStateTeardown.Routing)).assertTrue()
    })

    it('exitTeardownDoesNotUnloadThePages', 0, () => {
      // 退出小程序走的是 onAppEnterBackground：只派发 App.onHide，页面不收 onUnload，
      // 运行时紧接着整体销毁。iOS 的 PageStateTeardown.exit 与这里同源。
      expect(dispatchesPageUnload(DMPPageStateTeardown.Exit)).assertFalse()
    })
  })
}
