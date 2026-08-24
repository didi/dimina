import { describe, it, expect } from '@ohos/hypium'
import { invokeCanvasResult } from '../main/ets/Bridges/DMPContainerBridgesModule+Canvas'
import { DMPBridgeCallback, DMPBridgeCallbackType } from '../main/ets/Bridges/DMPTSUtil'
import { DMPMap } from '../main/ets/Utils/DMPMap'

export default function dmpCanvasCallbackTest() {
  describe('canvas callback results', () => {
    it('passes the success result to complete', 0, () => {
      const callbackTypes: DMPBridgeCallbackType[] = []
      const errMessages: string[] = []
      const callback: DMPBridgeCallback = (args: DMPMap, type: DMPBridgeCallbackType) => {
        callbackTypes.push(type)
        errMessages.push(args.getString('errMsg') ?? '')
      }
      const result = new DMPMap()
      result.set('errMsg', 'canvasToTempFilePath:ok')

      invokeCanvasResult(callback, result, DMPBridgeCallbackType.Success)

      expect(callbackTypes.length).assertEqual(2)
      expect(callbackTypes[0]).assertEqual(DMPBridgeCallbackType.Success)
      expect(callbackTypes[1]).assertEqual(DMPBridgeCallbackType.Complete)
      expect(errMessages[1]).assertEqual('canvasToTempFilePath:ok')
    })

    it('passes the failure result to complete', 0, () => {
      const callbackTypes: DMPBridgeCallbackType[] = []
      const errMessages: string[] = []
      const callback: DMPBridgeCallback = (args: DMPMap, type: DMPBridgeCallbackType) => {
        callbackTypes.push(type)
        errMessages.push(args.getString('errMsg') ?? '')
      }
      const result = new DMPMap()
      result.set('errMsg', 'canvasToTempFilePath:fail write failed')

      invokeCanvasResult(callback, result, DMPBridgeCallbackType.Fail)

      expect(callbackTypes.length).assertEqual(2)
      expect(callbackTypes[0]).assertEqual(DMPBridgeCallbackType.Fail)
      expect(callbackTypes[1]).assertEqual(DMPBridgeCallbackType.Complete)
      expect(errMessages[1]).assertEqual('canvasToTempFilePath:fail write failed')
    })
  })
}
