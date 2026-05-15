import { beforeEach, describe, expect, it, vi } from 'vitest'
import router from '../src/core/router.js'
import {
	canvasToTempFilePath,
	createCanvasContext,
	createContext,
} from '../src/api/core/ui/canvas/index.js'

describe('canvas api', () => {
	beforeEach(() => {
		router.setInitId('page_test')
		globalThis.DiminaServiceBridge.publish = vi.fn()
	})

	it('should record drawing actions', () => {
		const context = createContext()

		context.beginPath()
		context.moveTo(0, 0)
		context.lineTo(10, 10)
		context.setStrokeStyle('#f00')
		context.stroke()

		expect(context.getActions()).toEqual([
			{ type: 'beginPath', args: [] },
			{ type: 'moveTo', args: [0, 0] },
			{ type: 'lineTo', args: [10, 10] },
			{ type: 'setStrokeStyle', args: ['#f00'] },
			{ type: 'stroke', args: [] },
		])
	})

	it('should publish draw task to render when calling draw()', () => {
		const success = vi.fn()
		const context = createCanvasContext('main-canvas', { __id__: 'component_1' })

		context.rect(0, 0, 20, 20)
		context.draw(false, success)

		expect(globalThis.DiminaServiceBridge.publish).toHaveBeenCalledTimes(1)
		const [bridgeId, message] = globalThis.DiminaServiceBridge.publish.mock.calls[0]
		expect(bridgeId).toBe('page_test')
		expect(message.type).toBe('invokeAPI')
		expect(message.target).toBe('render')
		expect(message.body.name).toBe('drawCanvas')
		expect(message.body.params.canvasId).toBe('main-canvas')
		expect(message.body.params.moduleId).toBe('component_1')
		expect(message.body.params.actions).toEqual([{ type: 'rect', args: [0, 0, 20, 20] }])
		expect(typeof message.body.params.success).toBe('string')
		expect(context.getActions()).toEqual([])
	})

	it('should publish export task to render', () => {
		canvasToTempFilePath({ canvasId: 'main-canvas' }, { __id__: 'component_2' })

		expect(globalThis.DiminaServiceBridge.publish).toHaveBeenCalledTimes(1)
		const [bridgeId, message] = globalThis.DiminaServiceBridge.publish.mock.calls[0]
		expect(bridgeId).toBe('page_test')
		expect(message.body.name).toBe('canvasToTempFilePath')
		expect(message.body.params.canvasId).toBe('main-canvas')
		expect(message.body.params.moduleId).toBe('component_2')
	})
})
