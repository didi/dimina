import { describe, expect, it } from '@ohos/hypium'
import { DMPNavigatorManager } from '../main/ets/Navigator/DMPNavigatorManager'
import { DMPPageLifecycleLike } from '../main/ets/DPages/DMPPageLifecycle'

class FakePageLifecycle implements DMPPageLifecycleLike {
  shownWebViewIds: number[] = []
  hiddenWebViewIds: number[] = []

  onShow(webviewId: number): void {
    this.shownWebViewIds.push(webviewId)
  }

  onHide(webviewId: number): void {
    this.hiddenWebViewIds.push(webviewId)
  }
}

export default function dmpNavigatorManagerPageDispatchTest() {
  describe('DMPNavigatorManagerPageDispatch', () => {
    it('dispatchesPageShowAndHideEvenWhenTheNavigatorStackIsEmpty', 0, () => {
      // dispatchPageShow/dispatchPageHide never read `app` - only pageLifecycle does,
      // and it's replaced with the Fake below - so a real DMPApp (which would spin up
      // a DMPService/Worker on construction) is never needed here. `app` accepts null
      // specifically for this case (see DMPNavigatorManager's constructor).
      const fakePageLifecycle = new FakePageLifecycle()
      const manager = new DMPNavigatorManager(null, fakePageLifecycle)

      expect(manager.isEmpty()).assertTrue()

      manager.dispatchPageShow(42)
      manager.dispatchPageHide(42)

      expect(fakePageLifecycle.shownWebViewIds).assertDeepEquals([42])
      expect(fakePageLifecycle.hiddenWebViewIds).assertDeepEquals([42])
    })
  })
}
