import { describe, expect, it, vi } from 'vitest'
import { createRecordingContext, FailingImage, runtime, useCanvasRuntimeHarness } from './canvas-replay-test-utils.js'

describe('legacy canvas replay failures', () => {
	useCanvasRuntimeHarness()

	it('rejects an unknown action and does not replay following actions', async () => {
		const { ctx } = createRecordingContext()

		await expect(runtime.replayCanvasActions(ctx, [
			{ type: 'notARealCanvasAction', args: [1, 2, 3] },
			{ type: 'fillRect', args: [0, 0, 10, 10] },
		])).rejects.toThrow('Unsupported canvas action')

		expect(ctx.fillRect).not.toHaveBeenCalled()
	})

	it('does not execute a non-path context method embedded in a path snapshot', async () => {
		const { ctx } = createRecordingContext()
		await expect(runtime.replayCanvasActions(ctx, [{
			type: 'fillPath',
			args: [[{ type: 'clearRect', args: [0, 0, 10, 10] }]],
		}])).rejects.toThrow('Unsupported canvas path action')
		expect(ctx.clearRect).not.toHaveBeenCalled()
		expect(ctx.fill).not.toHaveBeenCalled()
	})

	it('rejects a drawImage batch when the image fails to load', async () => {
		globalThis.Image = FailingImage
		const { ctx } = createRecordingContext()

		await expect(runtime.replayCanvasActions(ctx, [
			{ type: 'drawImage', args: ['/missing.png', 0, 0] },
			{ type: 'fillRect', args: [0, 0, 10, 10] },
		])).rejects.toThrow('Failed to load image')

		expect(ctx.drawImage).not.toHaveBeenCalled()
		expect(ctx.fillRect).not.toHaveBeenCalled()
	})

	it('rejects a pattern batch when the pattern image fails to load', async () => {
		globalThis.Image = FailingImage
		const { ctx } = createRecordingContext()

		await expect(runtime.replayCanvasActions(ctx, [
			{
				type: 'setFillStyle',
				args: [{ __canvasStyle: 'pattern', image: '/missing-pattern.png', repetition: 'repeat' }],
			},
			{ type: 'fillRect', args: [0, 0, 10, 10] },
		])).rejects.toThrow('Failed to load image')

		expect(ctx.createPattern).not.toHaveBeenCalled()
		expect(ctx.fillRect).not.toHaveBeenCalled()
	})

	it('times out an image load that never settles and rejects the batch', async () => {
		vi.useFakeTimers()
		const originalTimeout = runtime.canvasImageTimeout
		runtime.canvasImageTimeout = 50
		class NeverSettlingImage {
			set src(value) { this._src = value }
			get src() { return this._src }
		}
		globalThis.Image = NeverSettlingImage
		const { ctx } = createRecordingContext()

		try {
			const replay = runtime.replayCanvasActions(ctx, [
				{ type: 'drawImage', args: ['/never-settles.png', 0, 0] },
				{ type: 'fillRect', args: [0, 0, 10, 10] },
			])
			const rejection = expect(replay).rejects.toThrow('Timed out loading image')
			await vi.advanceTimersByTimeAsync(500)
			await rejection
			expect(ctx.fillRect).not.toHaveBeenCalled()
		}
		finally {
			runtime.canvasImageTimeout = originalTimeout
		}
	}, 300)

	it.each([
		['arc', (ctx) => ctx.arc.mockImplementation(() => { throw new DOMException('negative radius', 'IndexSizeError') }), { type: 'arc', args: [10, 10, -5, 0, Math.PI * 2] }],
		['gradient', (ctx) => ctx.createRadialGradient.mockImplementation(() => { throw new DOMException('negative radius', 'IndexSizeError') }), {
			type: 'setFillStyle',
			args: [{ __canvasStyle: 'gradient', type: 'radial', data: [10, 10, -5], colorStop: [[0, 'red']] }],
		}],
		['line dash', (ctx) => ctx.setLineDash.mockImplementation(() => { throw new TypeError('invalid line dash') }), { type: 'setLineDash', args: [null, 0] }],
	])('stops the batch when %s replay throws', async (_label, arrange, failingAction) => {
		const { ctx } = createRecordingContext()
		arrange(ctx)

		await expect(runtime.replayCanvasActions(ctx, [
			failingAction,
			{ type: 'fillRect', args: [0, 0, 10, 10] },
		])).rejects.toThrow()
		expect(ctx.fillRect).not.toHaveBeenCalled()
	})

	it('sends fail and complete exactly once when an action throws', async () => {
		const { ctx } = createRecordingContext()
		const canvas = document.createElement('canvas')
		canvas.setAttribute('canvas-id', 'canvas-throwing-action')
		canvas.getContext = vi.fn(() => ctx)
		document.body.append(canvas)
		ctx.arc.mockImplementation(() => { throw new DOMException('negative radius', 'IndexSizeError') })
		const message = (await import('../src/core/message.js')).default
		const sendSpy = vi.spyOn(message, 'send').mockImplementation(() => {})

		await runtime.drawCanvas({
			bridgeId: 'bridge-throwing-action',
			params: {
				canvasId: 'canvas-throwing-action',
				actions: [
					{ type: 'arc', args: [10, 10, -5, 0, Math.PI * 2] },
					{ type: 'fillRect', args: [0, 0, 10, 10] },
				],
				success: 'onSuccess',
				fail: 'onFail',
				complete: 'onComplete',
			},
		})

		const ids = sendSpy.mock.calls.map(([msg]) => msg?.body?.id)
		expect(ids.filter(id => id === 'onFail')).toHaveLength(1)
		expect(ids.filter(id => id === 'onComplete')).toHaveLength(1)
		expect(ids).not.toContain('onSuccess')
		expect(ctx.fillRect).not.toHaveBeenCalled()
	})

	it('contains canvas lookup errors even when the caller does not await drawCanvas', async () => {
		const message = (await import('../src/core/message.js')).default
		const sendSpy = vi.spyOn(message, 'send').mockImplementation(() => {})
		const lookup = vi.spyOn(runtime, 'getCanvasElement').mockRejectedValueOnce(new Error('lookup failed'))
		const unhandled = []
		const onUnhandledRejection = reason => unhandled.push(reason)
		process.on('unhandledRejection', onUnhandledRejection)

		try {
			runtime.drawCanvas({
				bridgeId: 'bridge-bad-selector',
				params: {
					canvasId: 'foo"bar',
					actions: [{ type: 'fillRect', args: [0, 0, 10, 10] }],
					fail: 'onFail',
					complete: 'onComplete',
				},
			})
			await vi.waitFor(() => {
				const ids = sendSpy.mock.calls.map(([msg]) => msg?.body?.id)
				expect(ids.filter(id => id === 'onComplete')).toHaveLength(1)
			})

			expect(unhandled).toEqual([])
			const ids = sendSpy.mock.calls.map(([msg]) => msg?.body?.id)
			expect(ids.filter(id => id === 'onFail')).toHaveLength(1)
			expect(ids.filter(id => id === 'onComplete')).toHaveLength(1)
		}
		finally {
			process.off('unhandledRejection', onUnhandledRejection)
			lookup.mockRestore()
		}
	})
})
