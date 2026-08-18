import { describe, expect, it } from '@ohos/hypium'
import { DMPContainerBridgesModuleNavigateToMiniProgram } from '../main/ets/Bridges/DMPContainerBridgesModule+NavigateToMiniProgram'
import { DMPBridgeCallbackType } from '../main/ets/Bridges/DMPTSUtil'
import { WorkerAppData } from '../main/ets/Service/DMPSendableObjects'
import { DMPMap } from '../main/ets/Utils/DMPMap'

export default function dmpMiniProgramNavigationCallbackTest() {
  describe('DMPMiniProgramNavigationCallback', () => {
    it('passesTheSameFailureErrMsgToFailAndComplete', 0, async () => {
      const module = new DMPContainerBridgesModuleNavigateToMiniProgram(new WorkerAppData())
      const callbackTypes: DMPBridgeCallbackType[] = []
      const errMessages: string[] = []

      await module.restartMiniProgram(new DMPMap(), (args: DMPMap, type: DMPBridgeCallbackType) => {
        callbackTypes.push(type)
        errMessages.push(args.getString('errMsg') ?? '')
      })

      expect(callbackTypes.length).assertEqual(2)
      expect(callbackTypes[0]).assertEqual(DMPBridgeCallbackType.Fail)
      expect(callbackTypes[1]).assertEqual(DMPBridgeCallbackType.Complete)
      expect(errMessages[0]).assertContain('restartMiniProgram:fail')
      expect(errMessages[1]).assertEqual(errMessages[0])
    })
  })
}
