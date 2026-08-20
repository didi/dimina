import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createRecordingContext, mountCanvas, runtime, useCanvasRuntimeHarness } from './canvas-replay-test-utils.js'

describe('legacy canvas export and pixels', () => {
	useCanvasRuntimeHarness()

	beforeEach(() => {
		window.DiminaRenderBridge = { publish: vi.fn() }
	})

	it('serializes canvasToTempFilePath behind any in-flight draw() batch on the same canvas, so the exported picture reflects a fully replayed batch', async () => {
		const { ctx, record } = createRecordingContext()
		const canvas = document.createElement('canvas')
		// Patch the prototype of this JSDOM realm's actual HTMLCanvasElement
		// (not the bare global identifier, which belongs to a different
		// realm than the `document` this suite builds in beforeEach) so any
		// scratch/offscreen canvas canvasToTempFilePath creates internally
		// for cropping/resizing is covered too, not just this one instance.
		const canvasProto = Object.getPrototypeOf(canvas)
		const originalGetContext = canvasProto.getContext
		const originalToDataURL = canvasProto.toDataURL
		canvasProto.getContext = function () {
			return ctx
		}
		canvasProto.toDataURL = vi.fn(() => {
			record.push({ kind: 'call', name: 'toDataURL', args: [] })
			return 'data:image/png;base64,fake'
		})

		try {
			canvas.setAttribute('canvas-id', 'canvas-export-queue')
			canvas.width = 200
			canvas.height = 100
			document.body.append(canvas)

			let releaseSlowImage
			const slowImageLoaded = new Promise((resolve) => {
				releaseSlowImage = resolve
			})
			class SlowImage {
				set src(value) {
					this._src = value
					slowImageLoaded.then(() => this.onload?.())
				}

				get src() {
					return this._src
				}
			}
			globalThis.Image = SlowImage

			const drawBatch = runtime.drawCanvas({
				bridgeId: 'bridge-export-queue-draw',
				params: {
					canvasId: 'canvas-export-queue',
					reserve: true,
					actions: [
						{ type: 'drawImage', args: ['/slow.png', 0, 0] },
						{ type: 'fillRect', args: [0, 0, 10, 10] },
					],
				},
			})

			const exportCall = runtime.canvasToTempFilePath({
				bridgeId: 'bridge-export-queue-export',
				params: { canvasId: 'canvas-export-queue' },
			})

			await Promise.resolve()
			await Promise.resolve()
			await Promise.resolve()
			expect(canvasProto.toDataURL).not.toHaveBeenCalled()

			releaseSlowImage()
			await Promise.all([drawBatch, exportCall])

			const fillRectIndex = record.findIndex(entry => entry.kind === 'call' && entry.name === 'fillRect')
			const toDataURLIndex = record.findIndex(entry => entry.kind === 'call' && entry.name === 'toDataURL')
			expect(fillRectIndex).toBeGreaterThanOrEqual(0)
			expect(toDataURLIndex).toBeGreaterThan(fillRectIndex)
		}
		finally {
			canvasProto.getContext = originalGetContext
			canvasProto.toDataURL = originalToDataURL
		}
	})

	it('uses the device pixel ratio for omitted destination dimensions', async () => {
		const { ctx } = createRecordingContext()
		const source = mountCanvas('canvas-default-dpr', ctx)
		const canvasProto = Object.getPrototypeOf(source)
		const originalGetContext = canvasProto.getContext
		const originalToDataURL = canvasProto.toDataURL
		let exportedSize
		canvasProto.getContext = vi.fn(() => ctx)
		canvasProto.toDataURL = vi.fn(function () {
			exportedSize = { width: this.width, height: this.height }
			return 'data:image/png;base64,fake'
		})
		window.DiminaRenderBridge.invoke = vi.fn()

		try {
			await runtime.canvasToTempFilePath({
				bridgeId: 'bridge-default-dpr',
				params: {
					canvasId: 'canvas-default-dpr',
					width: 50,
					height: 25,
					pixelRatio: 2,
				},
			})

			expect(exportedSize).toEqual({ width: 100, height: 50 })
			expect(ctx.drawImage).toHaveBeenCalledWith(source, 0, 0, 50, 25, 0, 0, 100, 50)
		}
		finally {
			canvasProto.getContext = originalGetContext
			canvasProto.toDataURL = originalToDataURL
		}
	})

	it('normalizes an unsupported canvas export fileType to png', async () => {
		const { ctx } = createRecordingContext()
		const source = mountCanvas('canvas-invalid-file-type', ctx)
		const canvasProto = Object.getPrototypeOf(source)
		const originalGetContext = canvasProto.getContext
		const originalToDataURL = canvasProto.toDataURL
		canvasProto.getContext = vi.fn(() => ctx)
		canvasProto.toDataURL = vi.fn(() => 'data:image/png;base64,fake')
		window.DiminaRenderBridge.invoke = vi.fn()

		try {
			await runtime.canvasToTempFilePath({
				bridgeId: 'bridge-invalid-file-type',
				params: { canvasId: 'canvas-invalid-file-type', fileType: 'jpeg' },
			})

			expect(canvasProto.toDataURL).toHaveBeenCalledWith('image/png', 1)
			const invoke = window.DiminaRenderBridge.invoke.mock.calls[0][0]
			expect(invoke.body.params.fileType).toBe('png')
		}
		finally {
			canvasProto.getContext = originalGetContext
			canvasProto.toDataURL = originalToDataURL
		}
	})

	it('gets and puts legacy canvas pixel data through callback APIs', async () => {
		const imageData = { width: 1, height: 1, data: new Uint8ClampedArray([1, 2, 3, 4]) }
		const context = {
			getImageData: vi.fn(() => imageData),
			createImageData: vi.fn(() => ({ width: 1, height: 1, data: new Uint8ClampedArray(4) })),
			putImageData: vi.fn(),
		}
		mountCanvas('canvas-pixels', context)
		window.DiminaRenderBridge.publish = vi.fn()

		await runtime.canvasGetImageData({
			bridgeId: 'bridge-pixels-get',
			params: { canvasId: 'canvas-pixels', x: 0, y: 0, width: 1, height: 1, success: 'get-ok' },
		})
		await runtime.canvasPutImageData({
			bridgeId: 'bridge-pixels-put',
			params: {
				canvasId: 'canvas-pixels',
				x: 2,
				y: 3,
				width: 1,
				height: 1,
				data: [5, 6, 7, 8],
				success: 'put-ok',
			},
		})

		expect(context.getImageData).toHaveBeenCalledWith(0, 0, 1, 1)
		const created = context.createImageData.mock.results[0].value
		expect(Array.from(created.data)).toEqual([5, 6, 7, 8])
		expect(context.putImageData).toHaveBeenCalledWith(created, 2, 3)
		const messages = window.DiminaRenderBridge.publish.mock.calls.map(([payload]) => JSON.parse(payload))
		expect(messages.find(message => message.body.id === 'get-ok').body.args).toEqual(expect.objectContaining({
			width: 1,
			height: 1,
			data: [1, 2, 3, 4],
		}))
		expect(messages.find(message => message.body.id === 'put-ok').body.args.errMsg).toBe('canvasPutImageData:ok')
	})

	it('defends old service bundles by rejecting oversized pixel reads before allocating ImageData', async () => {
		const context = { getImageData: vi.fn() }
		mountCanvas('canvas-oversized-read', context)
		window.DiminaRenderBridge.publish = vi.fn()

		await runtime.canvasGetImageData({
			bridgeId: 'bridge-oversized-read',
			params: {
				canvasId: 'canvas-oversized-read',
				x: 0,
				y: 0,
				width: 4096,
				height: 4096,
				fail: 'get-fail',
			},
		})

		expect(context.getImageData).not.toHaveBeenCalled()
		const messages = window.DiminaRenderBridge.publish.mock.calls.map(([payload]) => JSON.parse(payload))
		expect(messages.find(message => message.body.id === 'get-fail').body.args.errMsg)
			.toContain('maximum transferable pixel data')
	})

	it('defends direct bridge calls by rejecting oversized pixel writes before creating ImageData', async () => {
		const context = { createImageData: vi.fn(), putImageData: vi.fn() }
		mountCanvas('canvas-oversized-write', context)
		window.DiminaRenderBridge.publish = vi.fn()

		await runtime.canvasPutImageData({
			bridgeId: 'bridge-oversized-write',
			params: {
				canvasId: 'canvas-oversized-write',
				x: 0,
				y: 0,
				width: 2048,
				height: 1025,
				data: [],
				fail: 'put-fail',
			},
		})

		expect(context.createImageData).not.toHaveBeenCalled()
		expect(context.putImageData).not.toHaveBeenCalled()
	})

	describe('per-canvas draw queue bookkeeping', () => {
		function hasQueueEntryFor(canvasId) {
			const canvas = document.querySelector(`canvas[canvas-id="${canvasId}"]`)
			return runtime.canvasDrawQueues.has(canvas)
		}

		it('clears the per-canvas draw queue entry once a single draw() batch has finished replaying', async () => {
			const { ctx } = createRecordingContext()
			mountCanvas('canvas-queue-single', ctx)

			await runtime.drawCanvas({
				bridgeId: 'bridge-queue-single',
				params: {
					canvasId: 'canvas-queue-single',
					reserve: true,
					actions: [{ type: 'moveTo', args: [1, 1] }],
				},
			})

			expect(hasQueueEntryFor('canvas-queue-single')).toBe(false)
		})

		it('keeps the draw queue entry while a second batch is still queued behind the first, then clears it once both have finished', async () => {
			const { ctx, record } = createRecordingContext()
			mountCanvas('canvas-queue-pending', ctx)

			let releaseSlowImage
			const slowImageLoaded = new Promise((resolve) => {
				releaseSlowImage = resolve
			})
			class SlowImage {
				set src(value) {
					this._src = value
					slowImageLoaded.then(() => this.onload?.())
				}

				get src() {
					return this._src
				}
			}
			globalThis.Image = SlowImage

			const firstBatch = runtime.drawCanvas({
				bridgeId: 'bridge-queue-pending-1',
				params: {
					canvasId: 'canvas-queue-pending',
					reserve: true,
					actions: [
						{ type: 'drawImage', args: ['/slow.png', 0, 0] },
						{ type: 'moveTo', args: [1, 1] },
					],
				},
			})
			await vi.waitFor(() => expect(hasQueueEntryFor('canvas-queue-pending')).toBe(true))

			const secondBatch = runtime.drawCanvas({
				bridgeId: 'bridge-queue-pending-2',
				params: {
					canvasId: 'canvas-queue-pending',
					reserve: true,
					actions: [{ type: 'lineTo', args: [2, 2] }],
				},
			})
			await Promise.resolve()
			expect(hasQueueEntryFor('canvas-queue-pending')).toBe(true)
			expect(ctx.lineTo).not.toHaveBeenCalled()

			releaseSlowImage()
			await Promise.all([firstBatch, secondBatch])

			expect(hasQueueEntryFor('canvas-queue-pending')).toBe(false)
			const order = record
				.filter(entry => entry.kind === 'call' && ['drawImage', 'moveTo', 'lineTo'].includes(entry.name))
				.map(entry => entry.name)
			expect(order).toEqual(['drawImage', 'moveTo', 'lineTo'])
		})

		it('clears the draw queue entry even when a batch fails partway through replay', async () => {
			const { ctx } = createRecordingContext()
			mountCanvas('canvas-queue-failure', ctx)
			ctx.moveTo.mockImplementation(() => {
				throw new Error('simulated failure partway through replay')
			})

			try {
				await runtime.drawCanvas({
					bridgeId: 'bridge-queue-failure',
					params: {
						canvasId: 'canvas-queue-failure',
						reserve: true,
						actions: [{ type: 'moveTo', args: [1, 1] }],
						fail: 'onDrawCanvasFail',
					},
				})
			}
			catch {
				// Whether drawCanvas swallows the replay error or lets it
				// propagate, the queue entry for this canvas must not survive it.
			}

			expect(hasQueueEntryFor('canvas-queue-failure')).toBe(false)
		})
	})
})
