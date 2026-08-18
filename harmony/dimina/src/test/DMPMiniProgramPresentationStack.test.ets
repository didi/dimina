import { describe, expect, it } from '@ohos/hypium'
import {
  DMPMiniProgramPathParser,
  DMPMiniProgramPresentationStack
} from '../main/ets/DApp/DMPMiniProgramPresentationStack'

export default function dmpMiniProgramPresentationStackTest() {
  describe('DMPMiniProgramPresentationStack', () => {
    it('recordsTheOpenerAndReturnsToItInLifoOrder', 0, () => {
      const stack = new DMPMiniProgramPresentationStack()

      expect(stack.ensureRoot(1, 'app-a')).assertTrue()
      expect(stack.push(1, 2, 'app-b')).assertTrue()
      expect(stack.openerAppIndex(2)).assertEqual(1)
      expect(stack.pop(2)?.appIndex).assertEqual(2)
      expect(stack.top()?.appIndex).assertEqual(1)
      expect(stack.size()).assertEqual(1)
    })

    it('rejectsOperationsFromAnAppThatIsNotPresentedOnTop', 0, () => {
      const stack = new DMPMiniProgramPresentationStack()

      stack.ensureRoot(1, 'app-a')
      stack.push(1, 2, 'app-b')

      expect(stack.push(1, 3, 'app-c')).assertFalse()
      expect(stack.pop(1)).assertUndefined()
      expect(stack.openerAppIndex(1)).assertUndefined()
      expect(stack.top()?.appIndex).assertEqual(2)
    })

    it('doesNotInventAnOpenerForTheHostOpenedRoot', 0, () => {
      const stack = new DMPMiniProgramPresentationStack()

      stack.ensureRoot(7, 'root-app')

      expect(stack.openerAppIndex(7)).assertUndefined()
    })

    it('rejectsAnAlreadyPresentedAppIdWithoutMutatingTheStack', 0, () => {
      const stack = new DMPMiniProgramPresentationStack()

      stack.ensureRoot(1, 'same-app')
      stack.push(1, 2, 'other-app')

      expect(stack.push(2, 3, 'same-app')).assertFalse()
      expect(stack.size()).assertEqual(2)
      expect(stack.top()?.appIndex).assertEqual(2)
      expect(stack.openerAppIndex(2)).assertEqual(1)
    })
  })

  describe('DMPMiniProgramPathParser', () => {
    it('keepsAnEmptyQueryEmptyWhenPathHasNoQuestionMark', 0, () => {
      const parsed = DMPMiniProgramPathParser.parse('/pages/index')

      expect(parsed.pagePath).assertEqual('pages/index')
      expect(parsed.query.hasOwnKey('')).assertFalse()
    })

    it('normalizesLeadingSlashesAndDecodesQueryPairs', 0, () => {
      const parsed = DMPMiniProgramPathParser.parse('///pages/detail?id=42&name=hello%20world')

      expect(parsed.pagePath).assertEqual('pages/detail')
      expect(parsed.query.getString('id')).assertEqual('42')
      expect(parsed.query.getString('name')).assertEqual('hello world')
    })
  })
}
