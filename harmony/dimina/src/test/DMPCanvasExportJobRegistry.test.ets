import { describe, expect, it } from '@ohos/hypium'
import { CanvasExportJobRegistry } from '../main/ets/Bridges/CanvasExportJobRegistry'

export default function dmpCanvasExportJobRegistryTest() {
  describe('canvas export job registry', () => {
    it('rejects the third pending export even when payloads are tiny', 0, () => {
      const appId = `app-count-${Date.now()}`
      const owner = '1:0'
      CanvasExportJobRegistry.activate(appId, owner)
      const first = CanvasExportJobRegistry.reserve(appId, owner, 'iVBORw0KGgo=')
      const second = CanvasExportJobRegistry.reserve(appId, owner, 'iVBORw0KGgo=')
      const third = CanvasExportJobRegistry.reserve(appId, owner, 'iVBORw0KGgo=')

      expect(first !== null).assertTrue()
      expect(second !== null).assertTrue()
      expect(third).assertNull()
    })

    it('drops not-started payloads when the runtime generation is invalidated', 0, () => {
      const appId = `app-reset-${Date.now()}`
      const oldOwner = '1:0'
      const newOwner = '1:1'
      CanvasExportJobRegistry.activate(appId, oldOwner)
      const oldFirst = CanvasExportJobRegistry.reserve(appId, oldOwner, 'iVBORw0KGgo=')
      const oldSecond = CanvasExportJobRegistry.reserve(appId, oldOwner, 'iVBORw0KGgo=')

      CanvasExportJobRegistry.activate(appId, newOwner)

      expect(oldFirst!.payload).assertNull()
      expect(oldSecond!.payload).assertNull()
      expect(CanvasExportJobRegistry.reserve(appId, newOwner, 'iVBORw0KGgo=') !== null).assertTrue()
      expect(CanvasExportJobRegistry.reserve(appId, newOwner, 'iVBORw0KGgo=') !== null).assertTrue()
    })

    it('keeps a running old job counted without letting a stale owner replace the current owner', 0, () => {
      const appId = `app-running-${Date.now()}`
      const oldOwner = '1:0'
      const newOwner = '2:0'
      CanvasExportJobRegistry.activate(appId, oldOwner)
      const running = CanvasExportJobRegistry.reserve(appId, oldOwner, 'old1')!
      const queued = CanvasExportJobRegistry.reserve(appId, oldOwner, 'old2')!
      expect(CanvasExportJobRegistry.begin(running)).assertEqual('old1')

      CanvasExportJobRegistry.activate(appId, newOwner)

      expect(queued.cancelled).assertTrue()
      expect(queued.payload).assertNull()
      expect(CanvasExportJobRegistry.reserve(appId, oldOwner, 'stale')).assertNull()
      expect(CanvasExportJobRegistry.reserve(appId, newOwner, 'new1') !== null).assertTrue()
      expect(CanvasExportJobRegistry.reserve(appId, newOwner, 'new2')).assertNull()

      CanvasExportJobRegistry.finish(running)
      expect(CanvasExportJobRegistry.reserve(appId, newOwner, 'new2') !== null).assertTrue()
    })

    it('rejects a closed owner and accepts a newly activated app instance', 0, () => {
      const appId = `app-reopen-${Date.now()}`
      const oldOwner = '1:0'
      const newOwner = '2:0'
      CanvasExportJobRegistry.activate(appId, oldOwner)
      const queued = CanvasExportJobRegistry.reserve(appId, oldOwner, 'old')!

      CanvasExportJobRegistry.deactivate(appId, oldOwner)

      expect(queued.cancelled).assertTrue()
      expect(queued.payload).assertNull()
      expect(CanvasExportJobRegistry.reserve(appId, oldOwner, 'stale')).assertNull()
      CanvasExportJobRegistry.activate(appId, newOwner)
      expect(CanvasExportJobRegistry.reserve(appId, newOwner, 'new') !== null).assertTrue()
    })
  })
}
