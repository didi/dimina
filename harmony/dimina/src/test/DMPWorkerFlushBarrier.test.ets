import { describe, expect, it } from '@ohos/hypium'
import { DMPWorkerFlushBarrier } from '../main/ets/Service/DMPWorkerFlushBarrier'

export default function dmpWorkerFlushBarrierTest() {
  describe('DMPWorkerFlushBarrier', () => {
    it('completesTheMatchingAckExactlyOnce', 0, () => {
      const barrier = new DMPWorkerFlushBarrier()
      let resolved = 0

      expect(barrier.register(1, () => resolved++)).assertTrue()
      barrier.complete(1)
      barrier.complete(1)

      expect(resolved).assertEqual(1)
      expect(barrier.pendingCount()).assertEqual(0)
    })

    it('releasesEveryWaiterAndRejectsFutureBarriersAfterWorkerFailure', 0, () => {
      const barrier = new DMPWorkerFlushBarrier()
      let resolved = 0

      barrier.register(1, () => resolved++)
      barrier.register(2, () => resolved++)
      barrier.markUnavailable()
      barrier.markUnavailable()

      expect(resolved).assertEqual(2)
      expect(barrier.pendingCount()).assertEqual(0)
      expect(barrier.register(3, () => resolved++)).assertFalse()
    })
  })
}
