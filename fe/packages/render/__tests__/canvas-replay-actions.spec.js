import { describe, expect, it } from 'vitest'
import { createRecordingContext, ResolvingImage, runtime, useCanvasRuntimeHarness } from './canvas-replay-test-utils.js'

describe('legacy canvas action replay', () => {
	useCanvasRuntimeHarness()

	describe('direct passthrough actions', () => {
		const cases = [
			['beginPath', []],
			['closePath', []],
			['moveTo', [10, 20]],
			['lineTo', [30, 40]],
			['rect', [0, 0, 50, 60]],
			['arc', [10, 10, 5, 0, Math.PI, false]],
			['arcTo', [1, 2, 3, 4, 5]],
			['quadraticCurveTo', [1, 2, 3, 4]],
			['bezierCurveTo', [1, 2, 3, 4, 5, 6]],
			['fill', []],
			['stroke', []],
			['clip', []],
			['clearRect', [0, 0, 10, 10]],
			['fillRect', [1, 2, 3, 4]],
			['strokeRect', [5, 6, 7, 8]],
			['save', []],
			// Unlike a real canvas idiom where save() is normally paired with a
			// restore(), a lone, unmatched restore() must still reach the real
			// context. The official replay layer does no batch-level save/restore
			// bookkeeping at all — the logic layer's drawingState stack is allowed
			// to outlive a single draw() call (see the cross-batch save/restore
			// persistence test below).
			['restore', []],
			['translate', [10, 20]],
			['rotate', [Math.PI / 4]],
			['scale', [2, 3]],
			['transform', [1, 0, 0, 1, 5, 5]],
			['setTransform', [1, 0, 0, 1, 0, 0]],
		]

		it.each(cases)('translates a %s action into ctx.%s(...args) with the same argument order', async (type, args) => {
			const { ctx } = createRecordingContext()
			await runtime.replayCanvasActions(ctx, [{ type, args }])
			expect(ctx[type]).toHaveBeenCalledTimes(1)
			expect(ctx[type]).toHaveBeenCalledWith(...args)
		})
	})

	describe('fillText / strokeText maxWidth handling', () => {
		it.each(['fillText', 'strokeText'])('does not forward undefined as maxWidth when the %s action only has 3 args', async (type) => {
			const { ctx } = createRecordingContext()
			await runtime.replayCanvasActions(ctx, [{ type, args: ['hello', 10, 20] }])
			expect(ctx[type]).toHaveBeenCalledWith('hello', 10, 20)
			expect(ctx[type].mock.calls[0]).toHaveLength(3)
		})

		it.each(['fillText', 'strokeText'])('forwards maxWidth when the %s action carries a 4th arg', async (type) => {
			const { ctx } = createRecordingContext()
			await runtime.replayCanvasActions(ctx, [{ type, args: ['hello', 10, 20, 100] }])
			expect(ctx[type]).toHaveBeenCalledWith('hello', 10, 20, 100)
			expect(ctx[type].mock.calls[0]).toHaveLength(4)
		})
	})

	describe('property-style actions', () => {
		it('keeps setGlobalAlpha in the 0-1 range, it does not divide by 255', async () => {
			const { ctx } = createRecordingContext()
			await runtime.replayCanvasActions(ctx, [{ type: 'setGlobalAlpha', args: [0.4] }])
			expect(ctx.globalAlpha).toBe(0.4)
		})

		it.each([
			['setLineCap', 'lineCap', 'round'],
			['setLineJoin', 'lineJoin', 'bevel'],
			['setLineWidth', 'lineWidth', 4],
			['setMiterLimit', 'miterLimit', 12],
			['setTextAlign', 'textAlign', 'center'],
			['setTextBaseline', 'textBaseline', 'top'],
			['setGlobalCompositeOperation', 'globalCompositeOperation', 'multiply'],
			['setLineDashOffset', 'lineDashOffset', 7],
			['setShadowBlur', 'shadowBlur', 3],
			['setShadowColor', 'shadowColor', '#123456'],
			['setShadowOffsetX', 'shadowOffsetX', 9],
			['setShadowOffsetY', 'shadowOffsetY', -9],
		])('a %s action assigns ctx.%s to its single arg', async (type, prop, value) => {
			const { ctx } = createRecordingContext()
			await runtime.replayCanvasActions(ctx, [{ type, args: [value] }])
			expect(ctx[prop]).toBe(value)
		})

		it('maps setTextBaseline(\'normal\') to ctx.textBaseline = \'alphabetic\', since \'normal\' is a legal value in WeChat\'s own docs but not a legal CanvasRenderingContext2D.textBaseline value', async () => {
			const { ctx } = createRecordingContext()
			await runtime.replayCanvasActions(ctx, [
				{ type: 'setTextBaseline', args: ['top'] },
				{ type: 'setTextBaseline', args: ['normal'] },
			])
			expect(ctx.textBaseline).toBe('alphabetic')
		})

		it('splits setLineDash into ctx.setLineDash(pattern) plus ctx.lineDashOffset = offset', async () => {
			const { ctx } = createRecordingContext()
			await runtime.replayCanvasActions(ctx, [{ type: 'setLineDash', args: [[4, 2], 3] }])
			expect(ctx.setLineDash).toHaveBeenCalledWith([4, 2])
			expect(ctx.setLineDash.mock.calls[0]).toHaveLength(1)
			expect(ctx.lineDashOffset).toBe(3)
		})

		it('expands a setShadow action into four sequential property writes in offsetX, offsetY, blur, color order', async () => {
			const { ctx, record } = createRecordingContext()
			await runtime.replayCanvasActions(ctx, [{ type: 'setShadow', args: [5, 6, 7, '#abcdef'] }])

			const shadowWrites = record.filter(entry =>
				entry.kind === 'set' && ['shadowOffsetX', 'shadowOffsetY', 'shadowBlur', 'shadowColor'].includes(entry.name),
			)
			expect(shadowWrites.map(entry => entry.name)).toEqual(['shadowOffsetX', 'shadowOffsetY', 'shadowBlur', 'shadowColor'])
			expect(shadowWrites.map(entry => entry.value)).toEqual([5, 6, 7, '#abcdef'])
		})
	})

	describe('font uses ctx.font as the sole source of truth', () => {
		it('overwrites ctx.font wholesale for a setFont action', async () => {
			const { ctx } = createRecordingContext()
			await runtime.replayCanvasActions(ctx, [{ type: 'setFont', args: ['italic bold 20px Georgia'] }])
			expect(ctx.font).toBe('italic bold 20px Georgia')
		})

		it('rewrites only the px number in the current ctx.font for setFontSize, keeping the rest intact', async () => {
			const { ctx } = createRecordingContext()
			await runtime.replayCanvasActions(ctx, [
				{ type: 'setFont', args: ['italic bold 12px Georgia'] },
				{ type: 'setFontSize', args: [30] },
			])
			expect(ctx.font).toBe('italic bold 30px Georgia')
		})

		it('does not touch ctx.font at all when no font action is replayed', async () => {
			const { ctx, record } = createRecordingContext()
			await runtime.replayCanvasActions(ctx, [{ type: 'fillRect', args: [0, 0, 10, 10] }])
			expect(record.some(entry => entry.kind === 'set' && entry.name === 'font')).toBe(false)
		})

		it('derives the setFontSize replacement from the live, restored ctx.font rather than a stale shadow copy', async () => {
			const { ctx } = createRecordingContext()
			await runtime.replayCanvasActions(ctx, [
				{ type: 'setFont', args: ['italic bold 12px Georgia'] },
				{ type: 'save', args: [] },
				{ type: 'setFont', args: ['16px Arial'] },
				{ type: 'restore', args: [] },
				{ type: 'setFontSize', args: [24] },
			])

			// A render layer that tracks font components separately from the real
			// ctx.font would still be sitting on '16px Arial' after restore() and
			// would compose 'Arial' at 24px here. The real, restored ctx.font is
			// 'italic bold 12px Georgia', so the only px-substituted result that
			// matches an implementation with no shadow state is this one.
			expect(ctx.font).toBe('italic bold 24px Georgia')
		})
	})

	describe('style deserialization', () => {
		it('assigns a plain string color to fillStyle unchanged', async () => {
			const { ctx } = createRecordingContext()
			await runtime.replayCanvasActions(ctx, [{ type: 'setFillStyle', args: ['#ff00ff'] }])
			expect(ctx.fillStyle).toBe('#ff00ff')
			expect(ctx.createLinearGradient).not.toHaveBeenCalled()
			expect(ctx.createRadialGradient).not.toHaveBeenCalled()
		})

		it('rebuilds a linear gradient descriptor via createLinearGradient + addColorStop, then assigns it to fillStyle', async () => {
			const { ctx } = createRecordingContext()
			await runtime.replayCanvasActions(ctx, [{
				type: 'setFillStyle',
				args: [{
					__canvasStyle: 'gradient',
					type: 'linear',
					data: [0, 0, 100, 100],
					colorStop: [[0, '#fff'], [0.5, '#888'], [1, '#000']],
				}],
			}])

			expect(ctx.createLinearGradient).toHaveBeenCalledWith(0, 0, 100, 100)
			const gradient = ctx.createLinearGradient.mock.results[0].value
			expect(gradient.addColorStop).toHaveBeenNthCalledWith(1, 0, '#fff')
			expect(gradient.addColorStop).toHaveBeenNthCalledWith(2, 0.5, '#888')
			expect(gradient.addColorStop).toHaveBeenNthCalledWith(3, 1, '#000')
			expect(ctx.fillStyle).toBe(gradient)
		})

		it('maps a circular gradient descriptor (radial, [x, y, r]) to createRadialGradient(x, y, 0, x, y, r)', async () => {
			const { ctx } = createRecordingContext()
			await runtime.replayCanvasActions(ctx, [{
				type: 'setStrokeStyle',
				args: [{
					__canvasStyle: 'gradient',
					type: 'radial',
					data: [50, 50, 30],
					colorStop: [[0, 'red'], [1, 'blue']],
				}],
			}])

			expect(ctx.createRadialGradient).toHaveBeenCalledWith(50, 50, 0, 50, 50, 30)
			const gradient = ctx.createRadialGradient.mock.results[0].value
			expect(gradient.addColorStop).toHaveBeenNthCalledWith(1, 0, 'red')
			expect(gradient.addColorStop).toHaveBeenNthCalledWith(2, 1, 'blue')
			expect(ctx.strokeStyle).toBe(gradient)
		})

		it('loads the pattern image before calling createPattern(image, repetition), then assigns the result to fillStyle', async () => {
			globalThis.Image = ResolvingImage
			const { ctx } = createRecordingContext()

			await runtime.replayCanvasActions(ctx, [{
				type: 'setFillStyle',
				args: [{ __canvasStyle: 'pattern', image: '/assets/tile.png', repetition: 'repeat' }],
			}])

			expect(ctx.createPattern).toHaveBeenCalledTimes(1)
			const [imageArg, repetitionArg] = ctx.createPattern.mock.calls[0]
			expect(imageArg.src).toBe('/assets/tile.png')
			expect(repetitionArg).toBe('repeat')
			expect(ctx.fillStyle).toBe(ctx.createPattern.mock.results[0].value)
		})
	})

})
