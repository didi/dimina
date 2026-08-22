import { describe, it, expect } from '@ohos/hypium'
import { DMPFileUrlConvertor } from '../main/ets/Bundle/Util/DMPFileUrlConvertor'

export default function dmpFileUrlConvertorTest() {
  describe('DMPFileUrlConvertor canvas temp paths', () => {
    it('roundTripsGeneratedCanvasFileNames', 0, () => {
      const fileName = 'canvas_01234567-89ab-cdef-0123-456789abcdef.png'
      const vPath = DMPFileUrlConvertor.canvasTempVPath(fileName)

      expect(vPath).assertEqual(`difile://canvas/${fileName}`)
      expect(DMPFileUrlConvertor.canvasTempFileName(vPath)).assertEqual(fileName)
      expect(DMPFileUrlConvertor.localPathFromVPath(vPath, '/sandbox/app/resource/tmp'))
        .assertEqual(`/sandbox/app/resource/tmp/${fileName}`)
    })

    it('rejectsTraversalAndUnownedCanvasNames', 0, () => {
      expect(DMPFileUrlConvertor.canvasTempFileName('difile://canvas/../secret.png')).assertEqual('')
      expect(DMPFileUrlConvertor.canvasTempFileName('difile://canvas/not-canvas.png')).assertEqual('')
      expect(DMPFileUrlConvertor.canvasTempFileName('difile://tmp/canvas_123.png')).assertEqual('')
    })

    it('deniesEveryPathWhenACanvasRootIsUnavailable', 0, () => {
      const roots: Array<string> = ['/sandbox/app/usr', '/sandbox/cache', DMPFileUrlConvertor.canvasTempRoot('../evil')]

      expect(DMPFileUrlConvertor.canvasTempRoot('../evil')).assertEqual('')
      expect(DMPFileUrlConvertor.isUnderAnyRoot('/sandbox/app/usr/a.png', roots)).assertTrue()
      expect(DMPFileUrlConvertor.isUnderAnyRoot('/etc/passwd', roots)).assertFalse()
      expect(DMPFileUrlConvertor.isUnderAnyRoot('/sandbox/app/usr-evil/a.png', roots)).assertFalse()
    })
  })
}
