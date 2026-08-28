import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callback, modDefine } from '@dimina/common'
import hostEnv from '../src/core/host-env.js'
import loader from '../src/core/loader.js'
import router from '../src/core/router.js'
import { createSelectorQuery } from '../src/api/core/wxml/selector-query/index.js'
import {
	canvasGetImageData,
	canvasPutImageData,
	canvasToTempFilePath,
	createCanvas,
	createCanvasContext,
	createContext,
	createOffscreenCanvas,
} from '../src/api/core/ui/canvas/index.js'
import { resetMiniGameCanvas } from '../src/api/core/ui/canvas/canvas-node.js'
import { createImage } from '../src/api/core/media/image/index.js'

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

	afterEach(() => {
		hostEnv.reset()
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

	it('creates a fresh screen canvas after its bridge is unloaded and reopened', () => {
		createCanvas({ width: 120, height: 80 })
		globalThis.DiminaServiceBridge.onMessage({
			type: 'pageUnload',
			body: { bridgeId: 'page_test' },
		})

		const reopened = createCanvas({ width: 64, height: 32 })

		expect(reopened).toMatchObject({ width: 64, height: 32, offscreen: false })
		expect(globalThis.DiminaServiceBridge.publish.mock.calls.map(([, msg]) => msg.body.name))
			.toEqual(['createGameCanvas', 'disposeCanvasNodes', 'createGameCanvas'])
	})

	it('keeps the current game canvas alive when the current resource load completes', () => {
		const screen = createCanvas({ width: 120, height: 80 })

		globalThis.DiminaServiceBridge.onMessage({
			type: 'resourceLoaded',
			body: { bridgeId: 'page_test', canvasCapabilities: {} },
		})
		const offscreen = createCanvas({ width: 64, height: 32 })

		expect(screen.disposed).toBe(false)
		expect(offscreen).toMatchObject({ width: 64, height: 32, offscreen: true })
		expect(globalThis.DiminaServiceBridge.publish.mock.calls.map(([, msg]) => msg.body.name))
			.toEqual(['createGameCanvas', 'createOffscreenCanvas'])
	})

	it('disposes the previous game canvas before evaluating a replacement game module', () => {
		const previous = createCanvas({ width: 120, height: 80 })
		globalThis.DiminaServiceBridge.invoke = vi.fn()
		let current
		const gamePath = 'canvas-reopen-game'
		modDefine(gamePath, () => {
			current = createCanvas({ width: 64, height: 32 })
		})

		loader.loadResource({
			appId: 'canvas-test',
			bridgeId: 'page_test',
			pagePath: gamePath,
			root: '.',
			baseUrl: '/',
			resourceLoadId: 'canvas-reopen-resource',
			runtimeType: 'game',
		})

		expect(previous.disposed).toBe(true)
		expect(current).toMatchObject({ width: 64, height: 32, offscreen: false })
		expect(globalThis.DiminaServiceBridge.publish.mock.calls.map(([, msg]) => msg.body.name))
			.toEqual(['createGameCanvas', 'disposeCanvasNodes', 'createGameCanvas'])
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
			{ type: 'setStrokeStyle', args: ['#f00'] },
			{
				type: 'strokePath',
				args: [[
					{ type: 'moveTo', args: [0, 0] },
					{ type: 'lineTo', args: [10, 10] },
				]],
			},
		])
	})

	it('should publish draw task to render when calling draw()', () => {
		const success = vi.fn()
		const context = createCanvasContext('main-canvas', { __id__: 'component_1' })

		context.rect(0, 0, 20, 20)
		context.fill()
		context.draw(false, success)

		expect(globalThis.DiminaServiceBridge.publish).toHaveBeenCalledTimes(1)
		const [bridgeId, message] = globalThis.DiminaServiceBridge.publish.mock.calls[0]
		expect(bridgeId).toBe('page_test')
		expect(message.type).toBe('invokeAPI')
		expect(message.target).toBe('render')
		expect(message.body.name).toBe('drawCanvas')
		expect(message.body.params.canvasId).toBe('main-canvas')
		expect(message.body.params.moduleId).toBe('component_1')
		expect(message.body.params.actions).toEqual([{
			type: 'fillPath',
			args: [[{ type: 'rect', args: [0, 0, 20, 20] }]],
		}])
		// draw's user callback is wired to the `complete` channel, matching WeChat, where draw reports through `complete` on both success and failure (whereas `success` only fires on success, leaking the stored callback.store() entry whenever the render side reports a failure).
		expect(typeof message.body.params.complete).toBe('string')
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

	it('forwards the simulated device pixel ratio for default export dimensions', () => {
		hostEnv.init({ systemInfo: { pixelRatio: 3 } })

		canvasToTempFilePath({ canvasId: 'main-canvas' })

		const [, message] = globalThis.DiminaServiceBridge.publish.mock.calls[0]
		expect(message.body.params.pixelRatio).toBe(3)
	})

	it('publishes canvasGetImageData and normalizes returned bytes to Uint8ClampedArray', () => {
		const success = vi.fn()
		canvasGetImageData({
			canvasId: 'main-canvas',
			x: 1,
			y: 2,
			width: 3,
			height: 4,
			success,
		}, { __id__: 'component_pixels' })

		const [, message] = globalThis.DiminaServiceBridge.publish.mock.calls[0]
		expect(message.body.name).toBe('canvasGetImageData')
		expect(message.body.params.moduleId).toBe('component_pixels')
		callback.invoke(message.body.params.success, { width: 1, height: 1, data: [1, 2, 3, 4] })
		expect(success).toHaveBeenCalledWith(expect.objectContaining({
			data: new Uint8ClampedArray([1, 2, 3, 4]),
		}))
	})

	it('leaves a failed canvasGetImageData complete result without a synthetic data field', () => {
		const complete = vi.fn()
		canvasGetImageData({
			canvasId: 'main-canvas',
			x: 0,
			y: 0,
			width: 1,
			height: 1,
			complete,
		})

		const [, message] = globalThis.DiminaServiceBridge.publish.mock.calls[0]
		callback.invoke(message.body.params.complete, { errMsg: 'canvasGetImageData:fail unavailable' })
		expect(complete).toHaveBeenCalledWith({ errMsg: 'canvasGetImageData:fail unavailable' })
		expect(complete.mock.calls[0][0]).not.toHaveProperty('data')
	})

	it('publishes canvasPutImageData with transport-safe byte data', () => {
		canvasPutImageData({
			canvasId: 'main-canvas',
			x: 0,
			y: 0,
			width: 1,
			height: 1,
			data: new Uint8ClampedArray([5, 6, 7, 8]),
			success: vi.fn(),
		}, { __id__: 'component_pixels' })

		const [, message] = globalThis.DiminaServiceBridge.publish.mock.calls[0]
		expect(message.body.name).toBe('canvasPutImageData')
		expect(message.body.params.data).toEqual([5, 6, 7, 8])
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

	it('models the standard 2d state defaults instead of treating unknown properties as methods', () => {
		const context = createOffscreenCanvas({ type: '2d' }).getContext('2d')

		expect(context.textAlign).toBe('start')
		expect(context.textBaseline).toBe('alphabetic')
		expect(context.lineCap).toBe('butt')
		expect(context.lineJoin).toBe('miter')
		expect(context.globalCompositeOperation).toBe('source-over')
	})

	it('ignores invalid 2d state assignments in both the synchronous proxy and render wire', async () => {
		const context = createOffscreenCanvas({ type: '2d' }).getContext('2d')
		context.lineWidth = -1
		context.globalAlpha = 2
		context.lineCap = 'invalid'
		context.fillStyle = 'definitely-not-a-color'
		context.shadowColor = 'bad'
		context.strokeStyle = 'var(--theme-color)'
		context.font = 'invalid'
		context.filter = 'invalid'
		context.letterSpacing = 'invalid'
		context.wordSpacing = null

		expect(context.lineWidth).toBe(1)
		expect(context.globalAlpha).toBe(1)
		expect(context.lineCap).toBe('butt')
		expect(context.fillStyle).toBe('#000000')
		expect(context.shadowColor).toBe('rgba(0, 0, 0, 0)')
		expect(context.strokeStyle).toBe('#000000')
		expect(context.font).toBe('10px sans-serif')
		expect(context.filter).toBe('none')
		expect(context.letterSpacing).toBe('0px')
		expect(context.wordSpacing).toBe('0px')

		await Promise.resolve()
		const flush = globalThis.DiminaServiceBridge.publish.mock.calls
			.map(([, message]) => message)
			.find(message => message.body.name === 'canvasNodeFlush')
		expect(flush.body.params.operations.filter(operation => operation.op === 'contextSetProperty'))
			.toEqual([])
	})

	it('keeps valid modern CSS and canvas state values', () => {
		const context = createOffscreenCanvas({ type: '2d' }).getContext('2d')
		context.fillStyle = 'oklch(60% 0.15 50)'
		context.strokeStyle = 'CanvasText'
		context.font = 'italic 12.5px "Example Sans"'
		context.filter = 'blur(2px) brightness(80%)'
		context.letterSpacing = '0.25em'
		context.wordSpacing = '2px'
		context.globalCompositeOperation = 'plus-lighter'

		expect(context.fillStyle).toBe('oklch(60% 0.15 50)')
		expect(context.strokeStyle).toBe('CanvasText')
		expect(context.font).toBe('italic 12.5px "Example Sans"')
		expect(context.filter).toBe('blur(2px) brightness(80%)')
		context.filter = 'url("foo\\\\")'
		expect(context.filter).toBe('url("foo\\\\")')
		expect(context.letterSpacing).toBe('0.25em')
		expect(context.wordSpacing).toBe('2px')
		expect(context.globalCompositeOperation).toBe('plus-lighter')
		context.fillStyle = 'r\\67 b(255 0 0)'
		expect(context.fillStyle).toBe('r\\67 b(255 0 0)')
	})

	it('does not block valid nested CSS math or scientific numeric syntax from render', () => {
		const context = createOffscreenCanvas({ type: '2d' }).getContext('2d')
		context.font = 'calc(10px + min(1vw, 2px)) serif'
		expect(context.font).toBe('calc(10px + min(1vw, 2px)) serif')
		context.font = '1e2px serif'
		context.letterSpacing = '1e2px'

		expect(context.font).toBe('1e2px serif')
		expect(context.letterSpacing).toBe('1e2px')
		context.font = '0 serif'
		expect(context.font).toBe('0 serif')
		context.font = 'math serif'
		expect(context.font).toBe('math serif')
		context.font = '10cqw serif'
		expect(context.font).toBe('10cqw serif')
		context.font = '12px "var(--font)"'
		expect(context.font).toBe('12px "var(--font)"')
		context.letterSpacing = '1dvi'
		expect(context.letterSpacing).toBe('1dvi')
		context.globalCompositeOperation = 'normal'
		expect(context.globalCompositeOperation).toBe('source-over')
	})

	it('mirrors save, restore, reset and backing-store resize state synchronously', () => {
		const canvas = createOffscreenCanvas({ type: '2d' })
		const context = canvas.getContext('2d')
		context.fillStyle = 'red'
		context.save()
		context.fillStyle = 'blue'
		context.restore()
		expect(context.fillStyle).toBe('red')

		context.fillStyle = 'green'
		context.reset()
		expect(context.fillStyle).toBe('#000000')

		context.fillStyle = 'purple'
		canvas.width = 300
		expect(context.fillStyle).toBe('#000000')
	})

	it('keeps JavaScript expando properties outside the canvas drawing-state stack', () => {
		const canvas = createOffscreenCanvas({ type: '2d' })
		const context = canvas.getContext('2d')
		context.foo = 'before-save'
		context.save()
		context.foo = 'after-save'
		context.restore()
		expect(context.foo).toBe('after-save')

		context.reset()
		expect(context.foo).toBe('after-save')
		canvas.height = 150
		expect(context.foo).toBe('after-save')
	})

	it('reconciles a restored optimistic snapshot with the render state', async () => {
		const context = createOffscreenCanvas({ type: '2d' }).getContext('2d')
		context.fillStyle = 'rgb(bad)'
		context.save()
		context.fillStyle = 'red'
		context.restore()
		await Promise.resolve()

		const flush = globalThis.DiminaServiceBridge.publish.mock.calls
			.map(([, message]) => message)
			.find(message => message.body.name === 'canvasNodeFlush')
		const restore = flush.body.params.operations.find(operation => operation.method === 'restore')
		expect(restore.feedback).toBe('stateSnapshot')
		callback.invoke(flush.body.params.feedback, {
			contexts: {
				[context.contextId]: {
					state: [{
						prop: 'fillStyle',
						sequence: restore.stateSequences.fillStyle,
						value: '#000000',
					}],
				},
			},
		})

		expect(context.fillStyle).toBe('#000000')
	})

	it('applies only the newest render readback for each 2d state property', async () => {
		const context = createOffscreenCanvas({ type: '2d' }).getContext('2d')
		context.fillStyle = 'oklch(60% 0.15 50)'
		await Promise.resolve()
		const firstFlush = globalThis.DiminaServiceBridge.publish.mock.calls
			.map(([, message]) => message)
			.find(message => message.body.name === 'canvasNodeFlush')

		context.fillStyle = 'CanvasText'
		await Promise.resolve()
		const flushes = globalThis.DiminaServiceBridge.publish.mock.calls
			.map(([, message]) => message)
			.filter(message => message.body.name === 'canvasNodeFlush')
		const secondFlush = flushes.at(-1)

		callback.invoke(secondFlush.body.params.feedback, {
			contexts: {
				[context.contextId]: {
					state: [{ prop: 'fillStyle', sequence: 2, value: '#000000' }],
				},
			},
		})
		callback.invoke(firstFlush.body.params.feedback, {
			contexts: {
				[context.contextId]: {
					state: [{ prop: 'fillStyle', sequence: 1, value: '#ff0000' }],
				},
			},
		})

		expect(context.fillStyle).toBe('#000000')
	})

	it('bounds unacknowledged state feedback by context property', async () => {
		const context = createOffscreenCanvas({ type: '2d' }).getContext('2d')
		await Promise.resolve()
		const creationFlush = globalThis.DiminaServiceBridge.publish.mock.calls
			.map(([, message]) => message)
			.find(message => message.body.name === 'canvasNodeFlush')
		callback.invoke(creationFlush.body.params.feedback, { contexts: {} })
		globalThis.DiminaServiceBridge.publish.mockClear()

		context.fillStyle = 'red'
		await Promise.resolve()
		const firstFeedback = globalThis.DiminaServiceBridge.publish.mock.calls[0][1].body.params.feedback
		context.fillStyle = 'blue'
		await Promise.resolve()
		const secondFeedback = globalThis.DiminaServiceBridge.publish.mock.calls[1][1].body.params.feedback

		expect(callback.callbacks[firstFeedback]).toBeUndefined()
		expect(callback.callbacks[secondFeedback]).toBeDefined()
	})

	it('uses confirmed host state when consecutive setters target an unsupported property', async () => {
		const context = createOffscreenCanvas({ type: '2d' }).getContext('2d')
		context.filter = 'blur(1px)'
		context.filter = 'blur(2px)'
		await Promise.resolve()

		const flush = globalThis.DiminaServiceBridge.publish.mock.calls
			.map(([, message]) => message)
			.find(message => message.body.name === 'canvasNodeFlush')
		const setters = flush.body.params.operations.filter(operation => operation.prop === 'filter')
		expect(setters.map(operation => operation.previousValue)).toEqual(['none', 'none'])
	})

	it('coalesces animation-frame state readback without dropping or reordering draw operations', async () => {
		const context = createOffscreenCanvas({ type: '2d' }).getContext('2d')
		for (let index = 0; index < 4; index += 1) {
			context.save()
			context.globalAlpha = 0.2 + index * 0.1
			context.fillStyle = index % 2 === 0 ? 'red' : 'blue'
			context.fillRect(index, index, 1, 1)
			context.restore()
		}
		await Promise.resolve()

		const flush = globalThis.DiminaServiceBridge.publish.mock.calls
			.map(([, message]) => message)
			.find(message => message.body.name === 'canvasNodeFlush')
		const operations = flush.body.params.operations

		expect(operations.filter(operation => operation.op === 'contextSetProperty')).toHaveLength(8)
		expect(operations.filter(operation => operation.method === 'fillRect')).toHaveLength(4)
		expect(operations.filter(operation => operation.feedback === 'state')).toHaveLength(0)
		const snapshots = operations.filter(operation => operation.feedback === 'stateSnapshot')
		expect(snapshots).toHaveLength(1)
		expect(snapshots[0].method).toBe('restore')
		expect(Object.keys(snapshots[0].stateSequences).sort()).toEqual(['fillStyle', 'globalAlpha'])
	})

	it('retains readback sequences referenced by an unmatched save frame', async () => {
		const context = createOffscreenCanvas({ type: '2d' }).getContext('2d')
		context.fillStyle = 'red'
		context.save()
		context.fillStyle = 'blue'
		await Promise.resolve()

		const flush = globalThis.DiminaServiceBridge.publish.mock.calls
			.map(([, message]) => message)
			.find(message => message.body.name === 'canvasNodeFlush')
		const setters = flush.body.params.operations.filter(operation => operation.prop === 'fillStyle')

		expect(setters).toHaveLength(2)
		expect(setters.every(operation => operation.feedback === 'state')).toBe(true)
		expect(flush.body.params.operations.find(operation => operation.method === 'save').feedback).toBeUndefined()
	})

	it('uses the available font engine for synchronous 2d measureText', () => {
		class FakeMeasureContext {
			measureText(text) {
				return { width: Number.parseFloat(this.font) * String(text).length }
			}
		}
		class FakeOffscreenCanvas {
			getContext() {
				return new FakeMeasureContext()
			}
		}
		const original = globalThis.OffscreenCanvas
		globalThis.OffscreenCanvas = FakeOffscreenCanvas
		try {
			const context = createOffscreenCanvas({ type: '2d' }).getContext('2d')
			context.font = '100px serif'

			expect(context.measureText('MMMM').width).toBe(400)
		}
		finally {
			globalThis.OffscreenCanvas = original
		}
	})

	it('tags ImageData on the wire so render can reconstruct a native ImageData object', async () => {
		const context = createOffscreenCanvas({ type: '2d' }).getContext('2d')
		const imageData = context.createImageData(1, 1)
		imageData.data.set([1, 2, 3, 4])
		context.putImageData(imageData, 0, 0)
		await Promise.resolve()

		const flush = globalThis.DiminaServiceBridge.publish.mock.calls
			.map(([, message]) => message)
			.find(message => message.body.name === 'canvasNodeFlush')
		const put = flush.body.params.operations.find(operation => operation.method === 'putImageData')
		expect(put.args[0]).toEqual({
			__canvasImageData: true,
			width: 1,
			height: 1,
			data: [1, 2, 3, 4],
		})
	})

	it('normalizes negative createImageData extents to positive dimensions', () => {
		const context = createOffscreenCanvas({ type: '2d' }).getContext('2d')

		const imageData = context.createImageData(-2, -3)

		expect(imageData.width).toBe(2)
		expect(imageData.height).toBe(3)
		expect(imageData.data).toBeInstanceOf(Uint8ClampedArray)
		expect(imageData.data).toHaveLength(24)
	})

	it('hydrates getImageData results as ImageData-compatible typed data', async () => {
		const context = createOffscreenCanvas({ type: '2d' }).getContext('2d')
		const pending = context.getImageData(0, 0, 1, 1)
		await Promise.resolve()
		const flush = globalThis.DiminaServiceBridge.publish.mock.calls
			.map(([, message]) => message)
			.find(message => message.body.name === 'canvasNodeFlush')
		const operation = flush.body.params.operations.find(item => item.op === 'getImageData')

		callback.invoke(operation.callback, {
			ok: true,
			value: { __canvasImageData: true, width: 1, height: 1, data: [5, 6, 7, 8] },
		})

		const imageData = await pending
		expect(imageData.width).toBe(1)
		expect(imageData.height).toBe(1)
		expect(imageData.data).toBeInstanceOf(Uint8ClampedArray)
		expect(Array.from(imageData.data)).toEqual([5, 6, 7, 8])
	})

	it('settles image load as one job and removes every callback in either terminal state', async () => {
		const canvas = createOffscreenCanvas({ type: '2d' })
		const image = canvas.createImage()
		image.onload = vi.fn()
		image.onerror = vi.fn()
		image.src = '/ok.png'
		await Promise.resolve()
		const flush = globalThis.DiminaServiceBridge.publish.mock.calls
			.map(([, message]) => message)
			.find(message => message.body.name === 'canvasNodeFlush')
		const operation = flush.body.params.operations.find(item => item.op === 'imageSetSrc')
		const callbackIds = [operation.callback, operation.onload, operation.onerror].filter(Boolean)
		expect(callbackIds.length).toBeGreaterThan(0)

		callback.invoke(operation.callback || operation.onload, {
			ok: true,
			value: { width: 10, height: 20 },
			width: 10,
			height: 20,
		})

		expect(callbackIds.every(id => callback.callbacks[id] === undefined)).toBe(true)
		expect(image.onload).toHaveBeenCalledOnce()
		expect(image.onerror).not.toHaveBeenCalled()
	})

	it('replacing image src cancels the callback owned by the superseded load', async () => {
		const canvas = createOffscreenCanvas({ type: '2d' })
		const image = canvas.createImage()
		image.src = '/first.png'
		await Promise.resolve()
		const firstFlush = globalThis.DiminaServiceBridge.publish.mock.calls
			.map(([, message]) => message)
			.find(message => message.body.name === 'canvasNodeFlush')
		const firstCallback = firstFlush.body.params.operations.find(item => item.op === 'imageSetSrc').callback
		expect(callback.callbacks[firstCallback]).toBeDefined()

		image.src = '/second.png'

		expect(callback.callbacks[firstCallback]).toBeUndefined()
	})

	it('cancelAnimationFrame removes the service callback immediately', () => {
		const canvas = createOffscreenCanvas({ type: '2d' })
		const requestId = canvas.requestAnimationFrame(vi.fn())
		const request = globalThis.DiminaServiceBridge.publish.mock.calls
			.map(([, message]) => message)
			.find(message => message.body.name === 'canvasNodeRequestAnimationFrame')
		expect(callback.callbacks[request.body.params.callback]).toBeDefined()

		canvas.cancelAnimationFrame(requestId)

		expect(callback.callbacks[request.body.params.callback]).toBeUndefined()
	})

	it('rejects pending pixel jobs and releases callbacks when a canvas node is disposed', async () => {
		const canvas = createOffscreenCanvas({ type: '2d' })
		const pending = canvas.toDataURL()
		await Promise.resolve()
		const flush = globalThis.DiminaServiceBridge.publish.mock.calls
			.map(([, message]) => message)
			.find(message => message.body.name === 'canvasNodeFlush')
		const operation = flush.body.params.operations.find(item => item.op === 'toDataURL')

		canvas.dispose()

		await expect(pending).rejects.toThrow('disposed')
		expect(callback.callbacks[operation.callback]).toBeUndefined()
	})

	it('page unload disposes every canvas-node callback owned by that bridge', async () => {
		const canvas = createOffscreenCanvas({ type: '2d' })
		const pending = canvas.toDataURL()
		await Promise.resolve()

		globalThis.DiminaServiceBridge.onMessage({
			type: 'pageUnload',
			body: { bridgeId: 'page_test' },
		})

		await expect(pending).rejects.toThrow('disposed')
	})

	it('page unload removes WebGL capabilities owned by the old bridge', () => {
		globalThis.DiminaServiceBridge.onMessage({
			type: 'canvasCapabilities',
			body: {
				bridgeId: 'page_test',
				capabilities: { webgl: { supported: false }, webgl2: { supported: false } },
			},
		})
		expect(createOffscreenCanvas({ type: 'webgl' }).getContext('webgl')).toBeNull()

		globalThis.DiminaServiceBridge.onMessage({
			type: 'pageUnload',
			body: { bridgeId: 'page_test' },
		})

		expect(createOffscreenCanvas({ type: 'webgl' }).getContext('webgl')).not.toBeNull()
	})

	it('rejects unsafe canvas-node dimensions before publishing or allocating pixel data', () => {
		expect(() => createOffscreenCanvas({ type: '2d', width: 4097, height: 1 }))
			.toThrow('maximum canvas bitmap')
		expect(globalThis.DiminaServiceBridge.publish).not.toHaveBeenCalled()

		const context = createOffscreenCanvas({ type: '2d' }).getContext('2d')
		expect(() => context.createImageData(4096, 4096)).toThrow('maximum canvas bitmap')
	})

	it('rejects a failed canvas-node pixel operation instead of leaving its Promise pending', async () => {
		const context = createOffscreenCanvas({ type: '2d' }).getContext('2d')
		const pending = context.getImageData(0, 0, 1, 1)
		await Promise.resolve()
		const flush = globalThis.DiminaServiceBridge.publish.mock.calls
			.map(([, message]) => message)
			.find(message => message.body.name === 'canvasNodeFlush')
		const operation = flush.body.params.operations.find(item => item.op === 'getImageData')

		callback.invoke(operation.callback, { ok: false, error: 'read failed' })

		await expect(pending).rejects.toThrow('read failed')
		expect(callback.callbacks[operation.callback]).toBeUndefined()
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
