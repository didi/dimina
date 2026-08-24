import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createRecordingContext, mountCanvas, runtime, useCanvasRuntimeHarness } from './canvas-replay-test-utils.js'

describe('legacy canvas draw state', () => {
	useCanvasRuntimeHarness()

	beforeEach(() => {
		window.DiminaRenderBridge = { publish: vi.fn() }
	})

	it('resets the complete backing-store state on reserve:false while retaining the leaked font', async () => {
		const { ctx } = createRecordingContext()
		mountCanvas('canvas-reserve-false-scope', ctx)

		await runtime.drawCanvas({
			bridgeId: 'bridge-reserve-false-scope-1',
			params: {
				canvasId: 'canvas-reserve-false-scope',
				reserve: true,
				actions: [
					{ type: 'save', args: [] },
					{ type: 'setFillStyle', args: ['#ff00ff'] },
					{ type: 'setStrokeStyle', args: ['#00ffff'] },
					{ type: 'translate', args: [50, 50] },
					{ type: 'setShadow', args: [3, 4, 5, '#00ff00'] },
					{ type: 'setFont', args: ['italic bold 22px Georgia'] },
					{ type: 'setLineDash', args: [[4, 4], 7] },
					{ type: 'setGlobalAlpha', args: [0.5] },
					{ type: 'setLineWidth', args: [9] },
					{ type: 'setLineCap', args: ['round'] },
					{ type: 'setLineJoin', args: ['bevel'] },
					{ type: 'setMiterLimit', args: [3] },
					{ type: 'setTextAlign', args: ['center'] },
					{ type: 'setTextBaseline', args: ['top'] },
					{ type: 'setGlobalCompositeOperation', args: ['multiply'] },
				],
			},
		})

		await runtime.drawCanvas({
			bridgeId: 'bridge-reserve-false-scope-2',
			params: {
				canvasId: 'canvas-reserve-false-scope',
				reserve: false,
				// A resize-reset empties the native save stack, so this restore is a no-op.
				actions: [{ type: 'restore', args: [] }],
			},
		})

		expect(ctx.fillStyle).toBe('#000000')
		expect(ctx.strokeStyle).toBe('#000000')
		expect(ctx.shadowOffsetX).toBe(0)
		expect(ctx.shadowOffsetY).toBe(0)
		expect(ctx.shadowBlur).toBe(0)
		expect(ctx.shadowColor).toBe('#000000')
		expect(ctx.globalAlpha).toBe(1)
		expect(ctx.lineWidth).toBe(1)
		expect(ctx.lineCap).toBe('butt')
		expect(ctx.lineJoin).toBe('miter')
		expect(ctx.miterLimit).toBe(10)
		expect(ctx.textAlign).toBe('start')
		expect(ctx.textBaseline).toBe('alphabetic')
		expect(ctx.globalCompositeOperation).toBe('source-over')
		expect(ctx.lineDashOffset).toBe(0)
		expect(ctx.font).toBe('italic bold 22px Georgia')
	})

	it('resets the line dash pattern and offset to defaults on every reserve:false batch, so a fresh createCanvasContext() on the same canvas does not inherit a stale dash pattern from an earlier context instance', async () => {
		const { ctx } = createRecordingContext()
		mountCanvas('canvas-linedash-reset', ctx)

		await runtime.drawCanvas({
			bridgeId: 'bridge-linedash-reset-1',
			params: {
				canvasId: 'canvas-linedash-reset',
				reserve: true,
				actions: [{ type: 'setLineDash', args: [[5, 5], 2] }],
			},
		})
		expect(ctx.lineDashOffset).toBe(2)

		await runtime.drawCanvas({
			bridgeId: 'bridge-linedash-reset-2',
			params: {
				canvasId: 'canvas-linedash-reset',
				reserve: false,
				actions: [{ type: 'strokeRect', args: [0, 0, 100, 100] }],
			},
		})

		expect(ctx.getLineDash()).toEqual([])
		expect(ctx.lineDashOffset).toBe(0)
	})

	it('persists a non-default lineDashOffset across reserve:true batches when the batch stream keeps repeating it', async () => {
		const { ctx } = createRecordingContext()
		mountCanvas('canvas-linedash-offset-persist', ctx)

		await runtime.drawCanvas({
			bridgeId: 'bridge-linedash-offset-persist-1',
			params: {
				canvasId: 'canvas-linedash-offset-persist',
				reserve: true,
				actions: [
					{ type: 'setLineDash', args: [[4, 4], 7] },
					{ type: 'stroke', args: [] },
				],
			},
		})
		expect(ctx.lineDashOffset).toBe(7)

		// Mirrors the logic layer's fixed prelude action for the next batch,
		// which now carries the real offset instead of hardcoding 0 — nothing
		// at the render layer should corrupt it in transit.
		await runtime.drawCanvas({
			bridgeId: 'bridge-linedash-offset-persist-2',
			params: {
				canvasId: 'canvas-linedash-offset-persist',
				reserve: true,
				actions: [
					{ type: 'setLineDash', args: [[4, 4], 7] },
					{ type: 'stroke', args: [] },
				],
			},
		})
		expect(ctx.lineDashOffset).toBe(7)
	})

	it('keeps the pixels but drops the previous batch fillStyle on reserve:true, matching the official draw() sample where an unrepeated red turns back into default black', async () => {
		const { ctx } = createRecordingContext()
		mountCanvas('canvas-reserve-true', ctx)

		await runtime.drawCanvas({
			bridgeId: 'bridge-reserve-true-1',
			params: {
				canvasId: 'canvas-reserve-true',
				reserve: true,
				actions: [
					{ type: 'setFillStyle', args: ['red'] },
					{ type: 'fillRect', args: [10, 10, 150, 100] },
				],
			},
		})

		const clearRectCallsBefore = ctx.clearRect.mock.calls.length
		const resizeResetsBefore = ctx.__resizeResetCount

		await runtime.drawCanvas({
			bridgeId: 'bridge-reserve-true-2',
			params: {
				canvasId: 'canvas-reserve-true',
				reserve: true,
				actions: [{ type: 'fillRect', args: [50, 50, 150, 100] }],
			},
		})

		// Pixels survive: neither a clearRect nor a backing-store rebuild happened.
		expect(ctx.clearRect.mock.calls.length).toBe(clearRectCallsBefore)
		expect(ctx.__resizeResetCount).toBe(resizeResetsBefore)
		expect(ctx.fillStyle).toBe('#000000')
	})

	it('resets transform and clip alongside the styles when a reserve:true batch starts, so the previous batch cannot pin the drawing region', async () => {
		const { ctx, getStackDepth } = createRecordingContext()
		mountCanvas('canvas-reserve-true-persist', ctx)

		await runtime.drawCanvas({
			bridgeId: 'bridge-reserve-true-persist-1',
			params: {
				canvasId: 'canvas-reserve-true-persist',
				reserve: true,
				actions: [
					{ type: 'setFillStyle', args: ['#123456'] },
					{ type: 'setLineWidth', args: [7] },
					{ type: 'translate', args: [40, 40] },
					{ type: 'rect', args: [0, 0, 10, 10] },
					{ type: 'clip', args: [] },
				],
			},
		})

		await runtime.drawCanvas({
			bridgeId: 'bridge-reserve-true-persist-2',
			params: {
				canvasId: 'canvas-reserve-true-persist',
				reserve: true,
				actions: [{ type: 'fillRect', args: [0, 0, 20, 20] }],
			},
		})

		expect(ctx.fillStyle).toBe('#000000')
		expect(ctx.lineWidth).toBe(1)
		// restore() is what unwinds translate and clip — a bare setTransform
		// would leave the clip region from batch 1 in place.
		expect(ctx.restore).toHaveBeenCalled()
		expect(getStackDepth()).toBe(1)
	})

	it('does not let an unmatched restore() pop the batch baseline frame, so the batch after it still starts from default state', async () => {
		const { ctx, getStackDepth } = createRecordingContext()
		mountCanvas('canvas-cross-batch-save', ctx)

		await runtime.drawCanvas({
			bridgeId: 'bridge-cross-batch-save-1',
			params: {
				canvasId: 'canvas-cross-batch-save',
				reserve: true,
				actions: [
					{ type: 'save', args: [] },
					{ type: 'setLineWidth', args: [7] },
				],
			},
		})
		expect(ctx.lineWidth).toBe(7)

		// The batch-1 save() was never matched by a restore(), yet its state
		// does not leak: the baseline frame unwinds the whole batch at once.
		await runtime.drawCanvas({
			bridgeId: 'bridge-cross-batch-save-2',
			params: {
				canvasId: 'canvas-cross-batch-save',
				reserve: true,
				// Three restores against a batch that saved nothing: on a real
				// canvas an empty stack makes restore() a no-op, and here they
				// must not reach past the baseline into the previous batch.
				actions: [
					{ type: 'restore', args: [] },
					{ type: 'restore', args: [] },
					{ type: 'restore', args: [] },
					{ type: 'setLineWidth', args: [3] },
				],
			},
		})
		expect(ctx.lineWidth).toBe(3)

		await runtime.drawCanvas({
			bridgeId: 'bridge-cross-batch-save-3',
			params: {
				canvasId: 'canvas-cross-batch-save',
				reserve: true,
				actions: [{ type: 'stroke', args: [] }],
			},
		})
		expect(ctx.lineWidth).toBe(1)
		// Exactly one live frame — the current batch baseline. Nothing accumulated.
		expect(getStackDepth()).toBe(1)
	})

})
