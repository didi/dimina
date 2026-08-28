import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createRecordingContext, mountCanvas, runtime, useCanvasRuntimeHarness } from './canvas-replay-test-utils.js'

// 官方类型对 wx.canvasToTempFilePath 的 quality 写的是「仅对 jpg 有效，取值范围为 (0, 1]，
// 不在范围内时当作 1.0 处理」。0 是开区间外的值，要当 1.0，而不是按 HTML toDataURL 的
// 闭区间原样传给宿主编码器（那样会导出一张最低质量的图）。
describe('canvasToTempFilePath encoding quality', () => {
	useCanvasRuntimeHarness()

	beforeEach(() => {
		window.DiminaRenderBridge = { invoke: vi.fn(), publish: vi.fn() }
	})

	async function encodeWith(params) {
		const { ctx } = createRecordingContext()
		const source = mountCanvas('export-quality', ctx)
		const canvasProto = Object.getPrototypeOf(source)
		const originalGetContext = canvasProto.getContext
		const originalToDataURL = canvasProto.toDataURL
		canvasProto.getContext = vi.fn(() => ctx)
		canvasProto.toDataURL = vi.fn(() => 'data:image/png;base64,exported')

		try {
			await runtime.canvasToTempFilePath({
				bridgeId: 'bridge-export-quality',
				params: { canvasId: 'export-quality', fail: 'export-failed', ...params },
			})
			return canvasProto.toDataURL.mock.calls[0]
		}
		finally {
			canvasProto.getContext = originalGetContext
			canvasProto.toDataURL = originalToDataURL
		}
	}

	it.each([
		['zero', 0],
		['negative', -0.5],
		['above one', 1.5],
		['non-numeric', 'high'],
		['unset', undefined],
	])('encodes jpg at full quality when quality is %s', async (_label, quality) => {
		expect(await encodeWith({ fileType: 'jpg', quality })).toEqual(['image/jpeg', 1])
	})

	it.each([
		['the lowest usable value', 0.01],
		['a mid-range value', 0.6],
		['the upper boundary', 1],
	])('passes %s through to the jpg encoder', async (_label, quality) => {
		expect(await encodeWith({ fileType: 'jpg', quality })).toEqual(['image/jpeg', quality])
	})

	// png 是无损的，quality 对它没有意义，任何取值都不能改变编码参数。
	it('ignores quality for png', async () => {
		expect(await encodeWith({ fileType: 'png', quality: 0.2 })).toEqual(['image/png', 1])
	})
})
