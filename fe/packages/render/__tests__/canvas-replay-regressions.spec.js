import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createRecordingContext, mountCanvas, runtime, useCanvasRuntimeHarness } from './canvas-replay-test-utils.js'

describe('legacy canvas callback, crop, scope and clip regressions', () => {
	useCanvasRuntimeHarness()

	beforeEach(() => {
		window.DiminaRenderBridge = { publish: vi.fn(), invoke: vi.fn() }
	})

	it('sends pixel API callback results as objects through the service callback envelope', async () => {
		const imageData = { width: 1, height: 1, data: new Uint8ClampedArray([1, 2, 3, 4]) }
		const context = {
			getImageData: vi.fn(() => imageData),
			createImageData: vi.fn(() => ({ width: 1, height: 1, data: new Uint8ClampedArray(4) })),
			putImageData: vi.fn(),
		}
		mountCanvas('callback-envelope', context)

		await runtime.canvasGetImageData({
			bridgeId: 'bridge-callback-get',
			params: { canvasId: 'callback-envelope', x: 0, y: 0, width: 1, height: 1, success: 'get-ok' },
		})
		await runtime.canvasPutImageData({
			bridgeId: 'bridge-callback-put',
			params: {
				canvasId: 'callback-envelope',
				x: 0,
				y: 0,
				width: 1,
				height: 1,
				data: [5, 6, 7, 8],
				success: 'put-ok',
			},
		})

		const messages = window.DiminaRenderBridge.publish.mock.calls.map(([payload]) => JSON.parse(payload))
		const getResult = messages.find(message => message.body.id === 'get-ok').body.args
		const putResult = messages.find(message => message.body.id === 'put-ok').body.args
		expect(Array.isArray(getResult)).toBe(false)
		expect(getResult.data).toEqual([1, 2, 3, 4])
		expect(Array.isArray(putResult)).toBe(false)
		expect(putResult.errMsg).toBe('canvasPutImageData:ok')
	})

	it('derives omitted crop and destination dimensions from the remaining source rectangle', async () => {
		const { ctx } = createRecordingContext()
		const source = mountCanvas('cropped-defaults', ctx)
		const canvasProto = Object.getPrototypeOf(source)
		const originalGetContext = canvasProto.getContext
		const originalToDataURL = canvasProto.toDataURL
		canvasProto.getContext = vi.fn(() => ctx)
		canvasProto.toDataURL = vi.fn(() => 'data:image/png;base64,cropped')

		try {
			await runtime.canvasToTempFilePath({
				bridgeId: 'bridge-cropped-defaults',
				params: { canvasId: 'cropped-defaults', x: 50, y: 20 },
			})

			const output = canvasProto.toDataURL.mock.instances[0]
			expect(output.width).toBe(150)
			expect(output.height).toBe(80)
			expect(ctx.drawImage).toHaveBeenCalledWith(source, 50, 20, 150, 80, 0, 0, 150, 80)
		}
		finally {
			canvasProto.getContext = originalGetContext
			canvasProto.toDataURL = originalToDataURL
		}
	})

	it('fails transport validation once through fail and complete without touching canvas pixels', async () => {
		const context = { getImageData: vi.fn() }
		mountCanvas('invalid-pixel-geometry', context)

		await runtime.canvasGetImageData({
			bridgeId: 'bridge-invalid-pixel-geometry',
			params: {
				canvasId: 'invalid-pixel-geometry',
				canvasValidationError: 'x must be finite',
				fail: 'invalid-fail',
				complete: 'invalid-complete',
			},
		})

		expect(context.getImageData).not.toHaveBeenCalled()
		const messages = window.DiminaRenderBridge.publish.mock.calls.map(([payload]) => JSON.parse(payload))
		expect(messages.filter(message => message.body.id === 'invalid-fail')).toHaveLength(1)
		expect(messages.filter(message => message.body.id === 'invalid-complete')).toHaveLength(1)
		expect(messages.find(message => message.body.id === 'invalid-fail').body.args).toEqual({
			errMsg: 'canvasGetImageData:fail x must be finite',
		})
	})

	it('rebuilds each path snapshot at its draw-time transform', async () => {
		const { ctx, record } = createRecordingContext()
		mountCanvas('path-snapshots', ctx)
		const path = [{ type: 'rect', args: [0, 0, 10, 10] }]

		await runtime.drawCanvas({
			bridgeId: 'bridge-path-snapshots',
			params: {
				canvasId: 'path-snapshots',
				reserve: true,
				actions: [
					{ type: 'fillPath', args: [path] },
					{ type: 'translate', args: [20, 0] },
					{ type: 'fillPath', args: [path] },
				],
			},
		})

		// The leading save() is the batch baseline frame that draw(reserve) unwinds later.
		const calls = record.filter(entry => entry.kind === 'call').map(entry => entry.name)
		expect(calls).toEqual(['save', 'beginPath', 'rect', 'fill', 'translate', 'beginPath', 'rect', 'fill'])
	})

	it('rebuilds on draw(false) even when restore removed the previous clip before batch end', async () => {
		const { ctx } = createRecordingContext()
		const canvas = mountCanvas('restored-clip', ctx)

		await runtime.drawCanvas({
			bridgeId: 'bridge-restored-clip-1',
			params: {
				canvasId: 'restored-clip',
				reserve: true,
				actions: [
					{ type: 'save', args: [] },
					{ type: 'save', args: [] },
					{ type: 'clip', args: [] },
					{ type: 'restore', args: [] },
				],
			},
		})

		const widthAssignments = []
		let storedWidth = canvas.width
		Object.defineProperty(canvas, 'width', {
			configurable: true,
			get: () => storedWidth,
			set(value) {
				widthAssignments.push(value)
				storedWidth = value
			},
		})

		await runtime.drawCanvas({
			bridgeId: 'bridge-restored-clip-2',
			params: { canvasId: 'restored-clip', reserve: false, actions: [] },
		})

		expect(widthAssignments).toHaveLength(1)
		expect(ctx.restore).toHaveBeenCalledTimes(1)
	})

	it('runs same-id canvases in different component scopes independently', async () => {
		const scopeA = document.createElement('div')
		const scopeB = document.createElement('div')
		document.body.append(scopeA, scopeB)
		const { ctx: ctxA } = createRecordingContext()
		const { ctx: ctxB } = createRecordingContext()
		const canvasA = mountCanvas('shared-id', ctxA)
		const canvasB = mountCanvas('shared-id', ctxB)
		scopeA.append(canvasA)
		scopeB.append(canvasB)
		runtime.instance.set('module-a', { $el: scopeA })
		runtime.instance.set('module-b', { $el: scopeB })

		let releaseImage
		const imageReady = new Promise((resolve) => {
			releaseImage = resolve
		})
		globalThis.Image = class {
			set src(value) {
				this._src = value
				imageReady.then(() => this.onload?.())
			}
		}

		const slowDraw = runtime.drawCanvas({
			bridgeId: 'bridge-scope-a',
			params: {
				canvasId: 'shared-id',
				moduleId: 'module-a',
				reserve: true,
				actions: [{ type: 'drawImage', args: ['/slow.png', 0, 0] }],
			},
		})
		const independentDraw = runtime.drawCanvas({
			bridgeId: 'bridge-scope-b',
			params: {
				canvasId: 'shared-id',
				moduleId: 'module-b',
				reserve: true,
				actions: [{ type: 'fillRect', args: [0, 0, 1, 1] }],
			},
		})

		await independentDraw
		expect(ctxB.fillRect).toHaveBeenCalledTimes(1)
		expect(ctxA.fillRect).not.toHaveBeenCalled()
		releaseImage()
		await slowDraw
	})

	it('does not fall back to another scope when the requested component has no matching canvas', async () => {
		const requestedScope = document.createElement('div')
		const otherScope = document.createElement('div')
		document.body.append(requestedScope, otherScope)
		const { ctx: otherContext } = createRecordingContext()
		const otherCanvas = mountCanvas('scoped-only', otherContext)
		otherScope.append(otherCanvas)
		runtime.instance.set('requested-module', { $el: requestedScope })

		await runtime.drawCanvas({
			bridgeId: 'bridge-missing-scope',
			params: {
				canvasId: 'scoped-only',
				moduleId: 'requested-module',
				actions: [{ type: 'fillRect', args: [0, 0, 1, 1] }],
				fail: 'missing-fail',
			},
		})

		expect(otherContext.fillRect).not.toHaveBeenCalled()
		const failure = window.DiminaRenderBridge.publish.mock.calls
			.map(([payload]) => JSON.parse(payload))
			.find(message => message.body.id === 'missing-fail')
		expect(failure.body.args.errMsg).toContain('not found')
	})
})
