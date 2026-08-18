import { describe, expect, it } from '@ohos/hypium'
import {
  DMPAppModuleManagerLifecycle,
  DMPDisposableAppModuleManager
} from '../main/ets/Bridges/DMPAppModuleManagerLifecycle'
import { DMPExtModuleHandler } from '../main/ets/Bridges/DMPExtModuleHandler'

class FakeDisposableAppModuleManager implements DMPDisposableAppModuleManager {
  disposeCount: number = 0
  registrations: Map<string, DMPExtModuleHandler> = new Map()

  registerExtModule(moduleName: string, handler: DMPExtModuleHandler): void {
    this.registrations.set(moduleName, handler)
  }

  dispose(): void {
    this.disposeCount++
  }
}

export default function dmpAppModuleManagerLifecycleTest() {
  describe('DMPAppModuleManagerLifecycle', () => {
    it('disposesOldManagerAndReplaysHostModulesIntoANewIdentity', 0, () => {
      const oldManager = new FakeDisposableAppModuleManager()
      const newManager = new FakeDisposableAppModuleManager()
      const lifecycle = new DMPAppModuleManagerLifecycle(oldManager,
        (): DMPDisposableAppModuleManager => newManager)
      const handler: DMPExtModuleHandler = (_event, _data, _callback) => null

      lifecycle.registerExtModule('host-location', handler)
      lifecycle.disposeCurrent()
      lifecycle.disposeCurrent()
      lifecycle.registerExtModule('host-payment', handler)
      const rebuiltManager = lifecycle.rebuild()

      expect(oldManager.disposeCount).assertEqual(1)
      expect(rebuiltManager === oldManager).assertFalse()
      expect(rebuiltManager === newManager).assertTrue()
      expect(newManager.registrations.get('host-location') === handler).assertTrue()
      expect(oldManager.registrations.has('host-payment')).assertFalse()
      expect(newManager.registrations.get('host-payment') === handler).assertTrue()
      expect(newManager.disposeCount).assertEqual(0)
    })
  })
}
