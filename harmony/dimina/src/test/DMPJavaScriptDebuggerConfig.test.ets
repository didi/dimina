import { describe, expect, it } from '@ohos/hypium'
import { DMPAppConfig } from '../main/ets/DApp/config/DMPAppConfig'
import { DMPJavaScriptSourceURL } from '../main/ets/Service/DMPJavaScriptSourceURL'

function setterThrows(port: number): boolean {
  try {
    new DMPAppConfig('demo', 'demo-app').setJavaScriptDebugger(port)
    return false
  } catch (_) {
    return true
  }
}

export default function dmpJavaScriptDebuggerConfigTest() {
  describe('Harmony JavaScript debugger configuration', () => {
    it('storesOnlyValidTcpPorts', 0, () => {
      const config = new DMPAppConfig('demo', 'demo-app')

      expect(config.setJavaScriptDebugger(9229) === config).assertTrue()
      expect(config.javaScriptDebuggerPort).assertEqual(9229)
      expect(setterThrows(0)).assertTrue()
      expect(setterThrows(65536)).assertTrue()
      expect(setterThrows(9229.5)).assertTrue()
    })

    it('buildsStableVirtualSourceUrlsWithoutTraversalSegments', 0, () => {
      expect(DMPJavaScriptSourceURL.SDK_SERVICE).assertEqual('/__dimina__/sdk/service.js')
      expect(DMPJavaScriptSourceURL.appLogic('demo/app', '')).assertEqual('/__dimina__/demo_app/main/logic.js')
      expect(DMPJavaScriptSourceURL.appLogic('demo', 'pkg/../sub'))
        .assertEqual('/__dimina__/demo/pkg/unknown/sub/logic.js')
      expect(DMPJavaScriptSourceURL.runtimeEval('demo/app'))
        .assertEqual('/__dimina__/demo_app/runtime/eval.js')
    })
  })
}
