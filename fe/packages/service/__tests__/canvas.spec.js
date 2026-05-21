import { beforeEach, describe, expect, it, vi } from 'vitest'
import { callback } from '@dimina/common'
import router from '../src/core/router.js'
import { createSelectorQuery } from '../src/api/core/wxml/selector-query/index.js'
import {
	canvasToTempFilePath,
	createCanvasContext,
	createContext,
	createOffscreenCanvas,
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

	it('should hydrate selector query canvas node results', () => {
		const execCallback = vi.fn()
		const nodeCallback = vi.fn()

		createSelectorQuery()
			.select('#canvas')
			.node(nodeCallback)
			.exec(execCallback)

		const [, message] = globalThis.DiminaServiceBridge.publish.mock.calls[0]
		const successId = message.body.params.success
		callback.invoke(successId, [{
			width: 300,
			height: 150,
			node: {
				__diminaNodeType: 'dimina-canvas-node',
				nodeId: 'canvas_1',
				type: 'webgl',
				width: 300,
				height: 150,
			},
		}])

		const canvas = execCallback.mock.calls[0][0][0].node
		expect(nodeCallback.mock.calls[0][0].node).toBe(canvas)
		expect(canvas.width).toBe(300)
		expect(canvas.height).toBe(150)
		expect(typeof canvas.getContext).toBe('function')
	})

	it('should create an offscreen webgl context proxy and flush commands', async () => {
		const canvas = createOffscreenCanvas({ type: 'webgl', width: 320, height: 200 })
		const gl = canvas.getContext('webgl')
		const shader = gl.createShader(gl.VERTEX_SHADER)

		gl.shaderSource(shader, 'void main() {}')
		gl.compileShader(shader)

		await Promise.resolve()

		expect(globalThis.DiminaServiceBridge.publish).toHaveBeenCalledTimes(2)
		const [, createMessage] = globalThis.DiminaServiceBridge.publish.mock.calls[0]
		const [, flushMessage] = globalThis.DiminaServiceBridge.publish.mock.calls[1]

		expect(createMessage.body.name).toBe('createOffscreenCanvas')
		expect(createMessage.body.params.width).toBe(320)
		expect(flushMessage.body.name).toBe('canvasNodeFlush')
		expect(flushMessage.body.params.operations.map(item => item.op)).toEqual([
			'getContext',
			'contextCall',
			'contextCall',
			'contextCall',
		])
		expect(flushMessage.body.params.operations[1].method).toBe('createShader')
	})
})
