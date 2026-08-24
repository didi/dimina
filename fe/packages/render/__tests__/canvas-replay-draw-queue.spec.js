import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createRecordingContext, mountCanvas, ResolvingImage, runtime, useCanvasRuntimeHarness } from './canvas-replay-test-utils.js'

describe('legacy canvas draw ordering and clipping', () => {
	useCanvasRuntimeHarness()

	beforeEach(() => {
		window.DiminaRenderBridge = { publish: vi.fn() }
	})

	it('serializes consecutive draw() batches on the same canvas so the second batch only starts once the first has fully replayed', async () => {
		globalThis.Image = ResolvingImage
		const { ctx, record } = createRecordingContext()
		mountCanvas('canvas-serial', ctx)

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

		// moveTo/lineTo (not fillRect/strokeRect) are used as the batch-order
		// markers here so this test isolates draw-batch serialization from the
		// unrelated action-dispatch coverage exercised elsewhere in this file.
		const firstBatch = runtime.drawCanvas({
			bridgeId: 'bridge-serial-1',
			params: {
				canvasId: 'canvas-serial',
				reserve: true,
				actions: [
					{ type: 'drawImage', args: ['/slow.png', 0, 0] },
					{ type: 'moveTo', args: [1, 1] },
				],
			},
		})
		const secondBatch = runtime.drawCanvas({
			bridgeId: 'bridge-serial-2',
			params: {
				canvasId: 'canvas-serial',
				reserve: true,
				actions: [{ type: 'lineTo', args: [2, 2] }],
			},
		})

		// Give both async chains room to reach their first await point before
		// unblocking the slow image. If the two batches are not serialized,
		// the second batch's synchronous lineTo action races ahead here.
		await Promise.resolve()
		await Promise.resolve()
		await Promise.resolve()
		expect(ctx.lineTo).not.toHaveBeenCalled()

		releaseSlowImage()
		await Promise.all([firstBatch, secondBatch])

		const order = record
			.filter(entry => entry.kind === 'call' && ['drawImage', 'moveTo', 'lineTo'].includes(entry.name))
			.map(entry => entry.name)
		expect(order).toEqual(['drawImage', 'moveTo', 'lineTo'])
	})

	it('serializes draw() batches on the same canvasId even when they carry different (or missing) moduleId values, since createCanvasContext(id) and createCanvasContext(id, this) key moduleId from different namespaces', async () => {
		const { ctx, record } = createRecordingContext()
		mountCanvas('canvas-cross-module', ctx)

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
		runtime.instance.set('page_xxx', { __page__: true })
		runtime.instance.set('bridge-cross-module-1', { __page__: true })

		const firstBatch = runtime.drawCanvas({
			bridgeId: 'bridge-cross-module-1',
			params: {
				canvasId: 'canvas-cross-module',
				moduleId: 'page_xxx',
				reserve: true,
				actions: [
					{ type: 'drawImage', args: ['/slow.png', 0, 0] },
					{ type: 'moveTo', args: [1, 1] },
				],
			},
		})
		const secondBatch = runtime.drawCanvas({
			bridgeId: 'bridge-cross-module-2',
			params: {
				canvasId: 'canvas-cross-module',
				// A different id namespace (e.g. a bridgeId instead of a module
				// instance id) for the very same canvas.
				moduleId: 'bridge-cross-module-1',
				reserve: true,
				actions: [{ type: 'lineTo', args: [2, 2] }],
			},
		})

		await Promise.resolve()
		await Promise.resolve()
		await Promise.resolve()
		expect(ctx.lineTo).not.toHaveBeenCalled()

		releaseSlowImage()
		await Promise.all([firstBatch, secondBatch])

		const order = record
			.filter(entry => entry.kind === 'call' && ['drawImage', 'moveTo', 'lineTo'].includes(entry.name))
			.map(entry => entry.name)
		expect(order).toEqual(['drawImage', 'moveTo', 'lineTo'])
	})

	it('rebuilds the backing store on every reserve:false batch to clear pixels, clip and the save stack', async () => {
		const { ctx } = createRecordingContext()
		const canvas = mountCanvas('canvas-clip-rebuild', ctx)
		const targetWidth = canvas.width

		await runtime.drawCanvas({
			bridgeId: 'bridge-clip-rebuild-1',
			params: {
				canvasId: 'canvas-clip-rebuild',
				actions: [
					{ type: 'rect', args: [0, 0, 50, 50] },
					{ type: 'clip', args: [] },
				],
			},
		})

		const widthAssignments = []
		let storedWidth = canvas.width
		Object.defineProperty(canvas, 'width', {
			configurable: true,
			get() {
				return storedWidth
			},
			set(value) {
				widthAssignments.push(value)
				storedWidth = value
			},
		})

		await runtime.drawCanvas({
			bridgeId: 'bridge-clip-rebuild-2',
			params: {
				canvasId: 'canvas-clip-rebuild',
				reserve: false,
				actions: [{ type: 'fillRect', args: [0, 0, 10, 10] }],
			},
		})

		// The only way to discard a clip region without a save/restore
		// bracket is to assign canvas.width — the width setter unconditionally
		// resets the backing store (and the clip with it) per the HTML
		// standard, whether or not the assigned value differs from the
		// current one.
		expect(widthAssignments.length).toBeGreaterThan(0)
		expect(canvas.width).toBe(targetWidth)
		expect(ctx.fillRect).toHaveBeenCalledWith(0, 0, 10, 10)

		// Reset is a property of reserve:false itself, not a one-shot clip mark.
		const assignmentsAfterBatch2 = widthAssignments.length
		await runtime.drawCanvas({
			bridgeId: 'bridge-clip-rebuild-3',
			params: {
				canvasId: 'canvas-clip-rebuild',
				reserve: false,
				actions: [{ type: 'fillRect', args: [0, 0, 5, 5] }],
			},
		})
		expect(widthAssignments.length).toBe(assignmentsAfterBatch2 + 1)
	})

	it('resets drawing properties to backing-store defaults when reserve is false', async () => {
		const { ctx } = createRecordingContext()
		mountCanvas('canvas-clip-preserve', ctx)

		// A clip region and non-default drawing properties all belong to the
		// backing-store state discarded by draw(false).
		await runtime.drawCanvas({
			bridgeId: 'bridge-clip-preserve-1',
			params: {
				canvasId: 'canvas-clip-preserve',
				reserve: true,
				actions: [
					{ type: 'setLineWidth', args: [7] },
					{ type: 'setLineCap', args: ['round'] },
					{ type: 'setLineJoin', args: ['bevel'] },
					{ type: 'setMiterLimit', args: [3] },
					{ type: 'setTextAlign', args: ['center'] },
					{ type: 'setTextBaseline', args: ['top'] },
					{ type: 'setGlobalCompositeOperation', args: ['multiply'] },
					{ type: 'rect', args: [0, 0, 50, 50] },
					{ type: 'clip', args: [] },
				],
			},
		})

		await runtime.drawCanvas({
			bridgeId: 'bridge-clip-preserve-2',
			params: {
				canvasId: 'canvas-clip-preserve',
				reserve: false,
				actions: [
					{ type: 'beginPath', args: [] },
					{ type: 'moveTo', args: [0, 10] },
					{ type: 'lineTo', args: [40, 10] },
					{ type: 'stroke', args: [] },
				],
			},
		})

		expect(ctx.lineWidth).toBe(1)
		expect(ctx.lineCap).toBe('butt')
		expect(ctx.lineJoin).toBe('miter')
		expect(ctx.miterLimit).toBe(10)
		expect(ctx.textAlign).toBe('start')
		expect(ctx.textBaseline).toBe('alphabetic')
		expect(ctx.globalCompositeOperation).toBe('source-over')
		expect(ctx.stroke).toHaveBeenCalled()
	})

	it('does not leak font state to a fresh Canvas element that reuses an old canvas-id', async () => {
		const { ctx: ctxA } = createRecordingContext()
		const canvasA = mountCanvas('board', ctxA)
		await runtime.drawCanvas({
			bridgeId: 'bridge-font-element-a',
			params: {
				canvasId: 'board',
				reserve: true,
				actions: [{ type: 'setFont', args: ['30px serif'] }],
			},
		})
		canvasA.remove()

		const { ctx: ctxB } = createRecordingContext()
		mountCanvas('board', ctxB)
		await runtime.drawCanvas({
			bridgeId: 'bridge-font-element-b',
			params: { canvasId: 'board', reserve: false, actions: [] },
		})

		expect(ctxA.font).toBe('30px serif')
		expect(ctxB.font).toBe('10px sans-serif')
	})

})
