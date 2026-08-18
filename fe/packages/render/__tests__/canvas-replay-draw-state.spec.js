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

	it('does not reset pixels or drawing state before replaying when reserve is true, letting drawing continue on the existing picture', async () => {
		const { ctx } = createRecordingContext()
		mountCanvas('canvas-reserve-true', ctx)

		await runtime.drawCanvas({
			bridgeId: 'bridge-reserve-true-1',
			params: {
				canvasId: 'canvas-reserve-true',
				reserve: true,
				actions: [{ type: 'setFillStyle', args: ['#ff00ff'] }],
			},
		})

		const clearRectCallsBefore = ctx.clearRect.mock.calls.length
		const setTransformCallsBefore = ctx.setTransform.mock.calls.length

		await runtime.drawCanvas({
			bridgeId: 'bridge-reserve-true-2',
			params: {
				canvasId: 'canvas-reserve-true',
				reserve: true,
				actions: [{ type: 'fillRect', args: [0, 0, 5, 5] }],
			},
		})

		expect(ctx.clearRect.mock.calls.length).toBe(clearRectCallsBefore)
		expect(ctx.setTransform.mock.calls.length).toBe(setTransformCallsBefore)
		expect(ctx.fillStyle).toBe('#ff00ff')
	})

	it('persists properties set in a reserve:true batch into the next reserve:true batch, since the service layer only resends changed style setters (not the full state) on every draw()', async () => {
		const { ctx } = createRecordingContext()
		mountCanvas('canvas-reserve-true-persist', ctx)

		await runtime.drawCanvas({
			bridgeId: 'bridge-reserve-true-persist-1',
			params: {
				canvasId: 'canvas-reserve-true-persist',
				reserve: true,
				actions: [
					{ type: 'setFillStyle', args: ['#123456'] },
					{ type: 'setLineWidth', args: [7] },
				],
			},
		})

		// Batch 2 only draws — mirroring the common case where a script sets
		// fillStyle once and keeps drawing with it across several draw()
		// calls without resetting it every time.
		await runtime.drawCanvas({
			bridgeId: 'bridge-reserve-true-persist-2',
			params: {
				canvasId: 'canvas-reserve-true-persist',
				reserve: true,
				actions: [{ type: 'fillRect', args: [0, 0, 20, 20] }],
			},
		})

		expect(ctx.fillStyle).toBe('#123456')
		expect(ctx.lineWidth).toBe(7)
	})

	it('passes save()/restore() straight through with no batch-level bookkeeping, so state saved in one batch survives into a later batch and a subsequent restore() can still pop it', async () => {
		const { ctx } = createRecordingContext()
		mountCanvas('canvas-cross-batch-save', ctx)

		// Official behavior: case 'save': l.save(); case 'restore': l.restore()
		// — a direct passthrough with no per-draw() balancing. The logic
		// layer's drawingState stack is allowed to outlive a single draw().
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

		await runtime.drawCanvas({
			bridgeId: 'bridge-cross-batch-save-2',
			params: {
				canvasId: 'canvas-cross-batch-save',
				reserve: true,
				actions: [
					{ type: 'beginPath', args: [] },
					{ type: 'moveTo', args: [0, 0] },
					{ type: 'lineTo', args: [100, 0] },
					{ type: 'stroke', args: [] },
				],
			},
		})
		// The save() from batch 1 was not auto-closed at its own batch end —
		// lineWidth set right after it is still 7 going into batch 2.
		expect(ctx.lineWidth).toBe(7)

		await runtime.drawCanvas({
			bridgeId: 'bridge-cross-batch-save-3',
			params: {
				canvasId: 'canvas-cross-batch-save',
				reserve: true,
				actions: [{ type: 'restore', args: [] }],
			},
		})
		// A later, batch-3 restore() still reaches the real context and pops
		// the state batch 1's save() pushed — it is not treated as "unmatched
		// within this batch" and swallowed.
		expect(ctx.restore).toHaveBeenCalledTimes(1)
		expect(ctx.lineWidth).toBe(1)
	})

})
