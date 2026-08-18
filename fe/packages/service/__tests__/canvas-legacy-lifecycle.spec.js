import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callback } from '@dimina/common'
import router from '../src/core/router.js'
import {
	createCanvasContext,
	createContext,
} from '../src/api/core/ui/canvas/index.js'


describe('legacy CanvasContext api', () => {
	beforeEach(() => {
		router.setInitId('page_test')
		globalThis.DiminaServiceBridge.publish = vi.fn()
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	describe('actions lifecycle', () => {
		it('getActions clears the internal buffer', () => {
			const context = createContext()
			context.clearRect(0, 0, 1, 1)

			expect(context.getActions()).toEqual([{ type: 'clearRect', args: [0, 0, 1, 1] }])
			expect(context.getActions()).toEqual([])
		})

		it('getActions deep-copies args arrays so mutating the snapshot cannot corrupt internal state', () => {
			const context = createContext()
			const pattern = [1, 2]
			context.setLineDash(pattern)
			const snapshot = context.getActions()
			snapshot[0].args[0].push(999)

			expect(context.getLineDash()).toEqual([1, 2])
		})

		it('clearActions empties the buffer and returns nothing', () => {
			const context = createContext()
			context.beginPath()

			expect(context.clearActions()).toBeUndefined()
			expect(context.getActions()).toEqual([])
		})

		it('draw warns and ignores a non-function callback instead of using it as the complete id', () => {
			const context = createCanvasContext('main-canvas', { __id__: 'component_1' })
			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
			context.clearRect(0, 0, 10, 10)
			context.draw(false, 'not-a-function')

			expect(warnSpy).toHaveBeenCalledWith('CanvasContext.draw callback is not a function, got string')
			const [, message] = globalThis.DiminaServiceBridge.publish.mock.calls[0]
			expect(message.body.params.complete).not.toBe('not-a-function')
		})

		it('routes the draw callback through the complete channel so it fires on both success and failure payloads from the render side', () => {
			const context = createCanvasContext('main-canvas', { __id__: 'component_1' })
			const userCallback = vi.fn()
			context.clearRect(0, 0, 10, 10)
			context.draw(false, userCallback)

			const [, message] = globalThis.DiminaServiceBridge.publish.mock.calls[0]
			expect(typeof message.body.params.complete).toBe('string')

			callback.invoke(message.body.params.complete, { errMsg: 'drawCanvas:fail something went wrong' })

			expect(userCallback).toHaveBeenCalledTimes(1)
			expect(userCallback).toHaveBeenCalledWith({ errMsg: 'drawCanvas:fail something went wrong' })
		})

		it('releases the stored draw callback after complete fires once, instead of leaking it in the callback table', () => {
			const context = createCanvasContext('main-canvas', { __id__: 'component_1' })
			const userCallback = vi.fn()
			context.clearRect(0, 0, 10, 10)
			context.draw(false, userCallback)

			const [, message] = globalThis.DiminaServiceBridge.publish.mock.calls[0]
			const completeId = message.body.params.complete
			callback.invoke(completeId, { errMsg: 'drawCanvas:ok' })
			callback.invoke(completeId, { errMsg: 'drawCanvas:ok' })

			expect(userCallback).toHaveBeenCalledTimes(1)
		})

		it('draw does not publish for a context created without a canvasId', () => {
			const context = createContext()
			context.clearRect(0, 0, 10, 10)
			context.draw(false, () => {})

			expect(globalThis.DiminaServiceBridge.publish).not.toHaveBeenCalled()
		})

		it('draw clears the recorded actions unconditionally, even for a context without a canvasId', () => {
			const context = createContext()
			context.clearRect(0, 0, 10, 10)
			context.draw(false, () => {})

			expect(context.getActions()).toEqual([])
		})

		it('does not accumulate paths across repeated draw() calls on a canvasId-less context', () => {
			const context = createContext()
			context.rect(0, 0, 1, 1)
			context.draw(false, () => {})
			context.moveTo(5, 5)
			context.draw(false, () => {})
			context.lineTo(9, 9)
			context.stroke()

			expect(context.getActions()).toEqual([{
				type: 'strokePath',
				args: [[{ type: 'moveTo', args: [9, 9] }]],
			}])
		})
	})

	describe('draw() publishes only actions recorded for that batch', () => {
		it('does not replay an old lineDash into a later reserve:false batch', () => {
			const context = createCanvasContext('c1', { __id__: 'm1' })
			context.setLineDash([4, 4], 7)
			context.draw(true, () => {})
			globalThis.DiminaServiceBridge.publish.mockClear()

			context.clearRect(0, 0, 1, 1)
			context.draw(false, () => {})

			const [, message] = globalThis.DiminaServiceBridge.publish.mock.calls[0]
			expect(message.body.params.actions).toEqual([{ type: 'clearRect', args: [0, 0, 1, 1] }])
		})

		it('does not replay an old font into a fresh backing store that reuses the canvas-id', () => {
			const context = createCanvasContext('c1', { __id__: 'm1' })
			context.font = 'italic bold 20px Arial'
			context.draw(true, () => {})
			globalThis.DiminaServiceBridge.publish.mockClear()

			context.clearRect(0, 0, 1, 1)
			context.draw(false, () => {})

			const [, message] = globalThis.DiminaServiceBridge.publish.mock.calls[0]
			expect(message.body.params.actions).toEqual([{ type: 'clearRect', args: [0, 0, 1, 1] }])
		})

		it.each([
			['font with reserve:true', true, context => { context.font = '18px serif' }],
			['lineDash with reserve:true', true, context => { context.setLineDash([2, 3], 4) }],
			['lineDashOffset with reserve:false', false, context => { context.lineDashOffset = 7 }],
			['lineDashOffset with reserve:true', true, context => { context.lineDashOffset = 7 }],
			['font and lineDash with reserve:false', false, context => { context.font = '18px serif'; context.setLineDash([2, 3], 4) }],
			['font and lineDash with reserve:true', true, context => { context.font = '18px serif'; context.setLineDash([2, 3], 4) }],
			['setFontSize state with reserve:false', false, context => { context.setFontSize(24) }],
			['restored lineDash state with reserve:false', false, context => { context.save(); context.setLineDash([2, 3], 4); context.restore() }],
			['default state with reserve:false', false, () => {}],
		])('does not synthesize stale %s actions for a later draw batch', (_name, reserve, setup) => {
			const context = createCanvasContext('c1', { __id__: 'm1' })
			setup(context)
			context.draw(true, () => {})
			globalThis.DiminaServiceBridge.publish.mockClear()

			context.clearRect(3, 4, 5, 6)
			context.draw(reserve, () => {})

			const [, message] = globalThis.DiminaServiceBridge.publish.mock.calls[0]
			expect(message.body.params.actions).toEqual([{ type: 'clearRect', args: [3, 4, 5, 6] }])
		})
	})
})
