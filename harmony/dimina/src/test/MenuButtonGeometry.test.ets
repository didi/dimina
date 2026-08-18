import { describe, it, expect } from '@ohos/hypium'
import { DMPMenuButtonLayout } from '../main/ets/Utils/DMPMenuButtonLayout'
import { DMPMap } from '../main/ets/Utils/DMPMap'

export default function menuButtonGeometryTest() {
  describe('menuButtonGeometry', () => {
    it('usesCurrentWindowCoordinates', 0, () => {
      const rect: DMPMap = DMPMenuButtonLayout.buildRect(390, 47)

      expect(rect.getNumber('width')).assertEqual(87)
      expect(rect.getNumber('height')).assertEqual(32)
      expect(rect.getNumber('right')).assertEqual(380)
      expect(rect.getNumber('left')).assertEqual(293)
      expect(rect.getNumber('top')).assertEqual(59)
      expect(rect.getNumber('bottom')).assertEqual(91)
    })

    it('keepsRectInsideCompactWindow', 0, () => {
      const rect: DMPMap = DMPMenuButtonLayout.buildRect(90, 24)

      expect(rect.getNumber('left')).assertLargerOrEqual(0)
      expect(rect.getNumber('right')).assertLessOrEqual(90)
    })
  })
}
