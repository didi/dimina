import { beforeEach, describe, expect, it, vi } from 'vitest'
import { callback } from '@dimina/common'
import router from '../src/core/router.js'
import { createSelectorQuery } from '../src/api/core/wxml/selector-query/index.js'
import {
	canvasToTempFilePath,
	createCanvas,
	createCanvasContext,
	createContext,
	createOffscreenCanvas,
} from '../src/api/core/ui/canvas/index.js'
import { resetMiniGameCanvas } from '../src/api/core/ui/canvas/canvas-node.js'
import { createImage } from '../src/api/core/media/image/index.js'
import hostEnv from '../src/core/host-env.js'

describe('canvas api', () => {
	function installWebGLCapabilities(overrides = {}) {
		globalThis.DiminaServiceBridge.onMessage({
			type: 'canvasCapabilities',
			body: {
				bridgeId: 'page_test',
				capabilities: {
					webgl: {
						supported: true,
						constants: {},
						parameters: {
							0x0D33: 8192,
						},
						contextAttributes: {
							alpha: true,
							depth: true,
							stencil: false,
							antialias: true,
							premultipliedAlpha: true,
							preserveDrawingBuffer: false,
						},
						supportedExtensions: ['ANGLE_instanced_arrays'],
						extensions: {
							ANGLE_instanced_arrays: {
								constants: { VERTEX_ATTRIB_ARRAY_DIVISOR_ANGLE: 0x88FE },
							},
						},
						shaderPrecisionFormats: {},
						...overrides,
					},
					webgl2: { supported: false },
				},
			},
		})
	}

	beforeEach(() => {
		resetMiniGameCanvas()
		router.setInitId('page_test')
		globalThis.DiminaServiceBridge.publish = vi.fn()
	})

	it('uses the first createCanvas call as the screen canvas and later calls as offscreen canvases', () => {
		hostEnv.init({ systemInfo: { windowWidth: 390, windowHeight: 844 } })
		const screen = createCanvas()
		const offscreen = createCanvas({ width: 64, height: 32 })

		expect(screen).toMatchObject({ width: 390, height: 844, offscreen: false })
		expect(offscreen).toMatchObject({ width: 64, height: 32, offscreen: true })
		expect(globalThis.DiminaServiceBridge.publish.mock.calls.map(([, msg]) => msg.body.name))
			.toEqual(['createGameCanvas', 'createOffscreenCanvas'])
	})

	it('does not consume the screen canvas when createImage is called first', async () => {
		createImage()
		const screen = createCanvas({ width: 120, height: 80 })

		expect(screen).toMatchObject({ width: 120, height: 80, offscreen: false })
		expect(globalThis.DiminaServiceBridge.publish.mock.calls.slice(0, 2).map(([, msg]) => msg.body.name))
			.toEqual(['createOffscreenCanvas', 'createGameCanvas'])

		await Promise.resolve()
		const flushMessage = globalThis.DiminaServiceBridge.publish.mock.calls
			.map(([, message]) => message)
			.find(message => message.body.name === 'canvasNodeFlush')
		expect(flushMessage.body.params.operations.map(operation => operation.op)).toEqual(['createImage'])
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
		const result = canvasToTempFilePath({ canvasId: 'main-canvas' }, { __id__: 'component_2' })

		expect(globalThis.DiminaServiceBridge.publish).toHaveBeenCalledTimes(1)
		const [bridgeId, message] = globalThis.DiminaServiceBridge.publish.mock.calls[0]
		expect(bridgeId).toBe('page_test')
		expect(message.body.name).toBe('canvasToTempFilePath')
		expect(message.body.params.canvasId).toBe('main-canvas')
		expect(message.body.params.moduleId).toBe('component_2')
		expect(result).toBeInstanceOf(Promise)
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
		installWebGLCapabilities()
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

	it('should follow canvas context identity and capability semantics', async () => {
		installWebGLCapabilities()
		const canvas = createOffscreenCanvas({ type: 'webgl', width: 0, height: 0 })
		const gl = canvas.getContext('experimental-webgl', {
			alpha: false,
			preserveDrawingBuffer: true,
		})

		expect(canvas.width).toBe(0)
		expect(canvas.height).toBe(0)
		expect(canvas.getContext('webgl')).toBe(gl)
		expect(canvas.getContext('2d')).toBeNull()
		expect(canvas.getContext('webgl2')).toBeNull()
		expect(gl.getContextAttributes()).toMatchObject({
			alpha: false,
			preserveDrawingBuffer: true,
		})
		expect(gl.getParameter(gl.MAX_TEXTURE_SIZE)).toBe(8192)

		gl.viewport(1, 2, 30, 40)
		gl.enable(gl.BLEND)
		expect(gl.getParameter(gl.VIEWPORT)).toEqual([1, 2, 30, 40])
		expect(gl.isEnabled(gl.BLEND)).toBe(true)

		const extension = gl.getExtension('angle_instanced_arrays')
		expect(extension.VERTEX_ATTRIB_ARRAY_DIVISOR_ANGLE).toBe(0x88FE)
		extension.vertexAttribDivisorANGLE(1, 2)

		await Promise.resolve()
		const [, flushMessage] = globalThis.DiminaServiceBridge.publish.mock.calls
			.find(([, message]) => message.body.name === 'canvasNodeFlush')
		expect(flushMessage.body.params.operations.map(item => item.op)).toContain('getExtension')
		expect(flushMessage.body.params.operations.map(item => item.op)).toContain('extensionCall')

		globalThis.DiminaServiceBridge.publish.mockClear()
		gl.clear(gl.COLOR_BUFFER_BIT)
		gl.drawArrays(gl.TRIANGLES, 0, 3)
		await Promise.resolve()
		const [, drawMessage] = globalThis.DiminaServiceBridge.publish.mock.calls[0]
		expect(drawMessage.body.params.feedback).toBeUndefined()
	})

	it('should apply render feedback for shader diagnostics, errors and pixel reads', async () => {
		installWebGLCapabilities()
		const canvas = createOffscreenCanvas({ type: 'webgl', width: 2, height: 1 })
		const creationError = vi.fn()
		canvas.addEventListener('webglcontextcreationerror', creationError)
		const gl = canvas.getContext('webgl')
		const shader = gl.createShader(gl.VERTEX_SHADER)
		gl.shaderSource(shader, 'invalid shader')
		gl.compileShader(shader)
		const pixels = new Uint8Array(8)
		gl.readPixels(0, 0, 2, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels)

		await Promise.resolve()
		const flushMessage = globalThis.DiminaServiceBridge.publish.mock.calls
			.map(([, message]) => message)
			.find(message => message.body.name === 'canvasNodeFlush')
		const { operations, feedback } = flushMessage.body.params
		const readPixels = operations.find(item => item.method === 'readPixels')

		callback.invoke(feedback, {
			contexts: {
				[gl.contextId]: {
					success: true,
					capabilities: {
						supported: true,
						contextAttributes: { alpha: false, preserveDrawingBuffer: true },
					},
					errors: [gl.INVALID_OPERATION],
					resources: [{
						resourceId: shader.__canvasResourceId,
						metadata: {
							compileStatus: false,
							infoLog: 'shader compilation failed',
						},
					}],
				},
			},
			typedArrays: [{
				id: readPixels.typedArrayUpdateId,
				value: {
					__canvasTypedArray: 'Uint8Array',
					data: [1, 2, 3, 4, 5, 6, 7, 8],
				},
			}],
		})

		expect(gl.getShaderParameter(shader, gl.COMPILE_STATUS)).toBe(false)
		expect(gl.getShaderInfoLog(shader)).toBe('shader compilation failed')
		expect(gl.getError()).toBe(gl.INVALID_OPERATION)
		expect(gl.getError()).toBe(gl.NO_ERROR)
		expect(Array.from(pixels)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
		expect(gl.getContextAttributes()).toMatchObject({ alpha: false, preserveDrawingBuffer: true })
		expect(creationError).not.toHaveBeenCalled()
	})

	it('should surface render-side context creation failures and allow retry', async () => {
		installWebGLCapabilities()
		const canvas = createOffscreenCanvas({ type: 'webgl' })
		const creationError = vi.fn()
		canvas.onwebglcontextcreationerror = creationError
		const firstContext = canvas.getContext('webgl')

		await Promise.resolve()
		const flushMessage = globalThis.DiminaServiceBridge.publish.mock.calls
			.map(([, message]) => message)
			.find(message => message.body.name === 'canvasNodeFlush')
		callback.invoke(flushMessage.body.params.feedback, {
			contexts: {
				[firstContext.contextId]: {
					success: false,
					statusMessage: 'WebGL is disabled',
				},
			},
		})

		expect(creationError).toHaveBeenCalledTimes(1)
		expect(creationError.mock.calls[0][0].statusMessage).toBe('WebGL is disabled')
		expect(canvas.getContext('webgl')).not.toBe(firstContext)
	})
})
