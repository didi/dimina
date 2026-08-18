import { describe, it, expect } from '@ohos/hypium'
import { DMPPageRecord } from '../main/ets/Navigator/DMPPageRecord'

export default function dmpPageRecordRouterOwnershipTest() {
  describe('DMPPageRecord.computeOwnsRouterEntry', () => {
    it('doesNotOwnRouterEntryWhenCustomLaunchPageCallBackMountsThePage', 0, () => {
      // customLaunchPageCallBack bypasses DRouter entirely, so the record never
      // occupies a shared NavPathStack slot.
      expect(DMPPageRecord.computeOwnsRouterEntry(true)).assertEqual(false)
    })

    it('ownsRouterEntryWhenDRouterMountsThePage', 0, () => {
      // Without a custom launch callback, openPage mounts the page through
      // DRouter push/replace, which does occupy a NavPathStack slot.
      expect(DMPPageRecord.computeOwnsRouterEntry(false)).assertEqual(true)
    })
  })

  describe('DMPPageRecord.shouldPopRouter', () => {
    it('popsRouterWhenTheRecordOwnsANavPathStackSlot', 0, () => {
      expect(DMPPageRecord.shouldPopRouter(true)).assertEqual(true)
    })

    it('skipsPopWhenTheRecordNeverOccupiedANavPathStackSlot', 0, () => {
      // Calling DRouter.pop() for a page that never occupied a slot would
      // pop an unrelated page instead.
      expect(DMPPageRecord.shouldPopRouter(false)).assertEqual(false)
    })

    it('defaultsToPoppingWhenNoPageRecordIsAvailableToCheck', 0, () => {
      // Conservative default matching the pre-existing behavior of both
      // call sites when the stack is already empty and no record can be found.
      expect(DMPPageRecord.shouldPopRouter(undefined)).assertEqual(true)
    })
  })
}
