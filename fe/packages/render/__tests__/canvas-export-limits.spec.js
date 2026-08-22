import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createRecordingContext, mountCanvas, runtime, useCanvasRuntimeHarness } from './canvas-replay-test-utils.js'

// 导出的尺寸完全由小程序给的参数决定。渲染层是唯一知道最终宽高的一方：桥接层只看得到编码后的
// 字符串，等它拒绝时，位图和 data URL 已经在渲染线程上同步分配并算完了。
describe('canvas export size limits', () => {
	useCanvasRuntimeHarness()

	beforeEach(() => {
		window.DiminaRenderBridge = { invoke: vi.fn(), publish: vi.fn() }
	})

	function failMessages() {
		return window.DiminaRenderBridge.publish.mock.calls
			.map(([payload]) => JSON.parse(payload))
			.filter(message => message.body?.id === 'export-failed')
			.map(message => message.body.args?.errMsg)
	}

	// 挂上去的画布是 200 × 100，未指定目标尺寸且 pixelRatio 为 1 时导出的就是这个大小。
	async function exportWith(params) {
		const { ctx } = createRecordingContext()
		const source = mountCanvas('export-limits', ctx)
		const canvasProto = Object.getPrototypeOf(source)
		const originalGetContext = canvasProto.getContext
		const originalToDataURL = canvasProto.toDataURL
		const createElement = vi.spyOn(document, 'createElement')
		canvasProto.getContext = vi.fn(() => ctx)
		canvasProto.toDataURL = vi.fn(() => 'data:image/png;base64,exported')

		try {
			await runtime.canvasToTempFilePath({
				bridgeId: 'bridge-export-limits',
				params: { canvasId: 'export-limits', fail: 'export-failed', ...params },
			})
			return {
				allocatedCanvasCount: createElement.mock.calls.filter(([tag]) => tag === 'canvas').length,
				ctx,
				toDataURL: canvasProto.toDataURL,
			}
		}
		finally {
			createElement.mockRestore()
			canvasProto.getContext = originalGetContext
			canvasProto.toDataURL = originalToDataURL
		}
	}

	function drawnSize(ctx) {
		const call = ctx.drawImage.mock.calls.at(-1)
		return call ? { height: call[8], width: call[7] } : null
	}

	it('rejects an export whose pixel count cannot fit the bridge limit, before allocating it', async () => {
		const { allocatedCanvasCount, toDataURL } = await exportWith({ destHeight: 30000, destWidth: 30000 })

		expect(allocatedCanvasCount).toBe(0)
		expect(toDataURL).not.toHaveBeenCalled()
		expect(failMessages()).toHaveLength(1)
		expect(failMessages()[0]).toContain('canvasToTempFilePath:fail')
	})

	it.each([
		['width', { destHeight: 1, destWidth: 4097 }],
		['height', { destHeight: 4097, destWidth: 1 }],
	])('rejects an export whose %s exceeds the cross-WebView axis limit before allocation', async (_axis, params) => {
		const { allocatedCanvasCount, toDataURL } = await exportWith(params)

		expect(allocatedCanvasCount).toBe(0)
		expect(toDataURL).not.toHaveBeenCalled()
		expect(failMessages()).toHaveLength(1)
	})

	// pixelRatio 已经挡住了非有限数，destWidth / destHeight 走的却是 `Number(v) || fallback`：
	// Infinity 和负数都是真值，会原样变成位图尺寸。这里按 pixelRatio 的既有约定收敛：
	// 给不出可用尺寸就当没给，回落到源矩形，而不是失败。
	it.each([
		['Infinity', Number.POSITIVE_INFINITY],
		['negative', -1024],
	])('treats a %s destination width as unset instead of sizing the bitmap with it', async (_label, destWidth) => {
		const { ctx, toDataURL } = await exportWith({ destWidth })

		expect(failMessages()).toEqual([])
		expect(toDataURL).toHaveBeenCalledTimes(1)
		expect(drawnSize(ctx)).toEqual({ height: 100, width: 200 })
	})

	// 放大导出是正常用法，上限只针对真正装不下的请求。
	it('still exports a request that stays inside the limit', async () => {
		const { ctx, toDataURL } = await exportWith({ destHeight: 200, destWidth: 400 })

		expect(toDataURL).toHaveBeenCalledTimes(1)
		expect(failMessages()).toEqual([])
		expect(drawnSize(ctx)).toEqual({ height: 200, width: 400 })
	})

	it('keeps the documented axis boundary available', async () => {
		const { ctx, toDataURL } = await exportWith({ destHeight: 1, destWidth: 4096 })

		expect(toDataURL).toHaveBeenCalledTimes(1)
		expect(failMessages()).toEqual([])
		expect(drawnSize(ctx)).toEqual({ height: 1, width: 4096 })
	})
})
