import { beforeEach, describe, expect, it, vi } from 'vitest'
import router from '../src/core/router.js'
import {
	canvasGetImageData,
	canvasPutImageData,
	canvasToTempFilePath,
} from '../src/api/core/ui/canvas/index.js'

describe('legacy canvas numeric transport normalization', () => {
	beforeEach(() => {
		router.setInitId('page_canvas_transport')
		globalThis.DiminaServiceBridge.publish = vi.fn()
	})

	function publishedParams() {
		return globalThis.DiminaServiceBridge.publish.mock.calls.at(-1)[1].body.params
	}

	it('normalizes NaN pixel coordinates before JSON transport', () => {
		canvasGetImageData({
			canvasId: 'main',
			x: Number.NaN,
			y: Number.NaN,
			width: 1,
			height: 1,
			success: vi.fn(),
		})

		expect(publishedParams()).toMatchObject({ x: 0, y: 0, width: 1, height: 1 })
		expect(publishedParams().canvasValidationError).toBeUndefined()
	})

	it('marks infinite pixel geometry as invalid instead of allowing JSON.stringify to collapse it to null', () => {
		canvasGetImageData({
			canvasId: 'main',
			x: Number.POSITIVE_INFINITY,
			y: 0,
			width: 1,
			height: 1,
			fail: vi.fn(),
		})

		expect(publishedParams().canvasValidationError).toContain('finite')
		expect(JSON.stringify(publishedParams())).not.toContain('"x":null')
	})

	it('requires putImageData data to be a Uint8ClampedArray before crossing the bridge', () => {
		canvasPutImageData({
			canvasId: 'main',
			x: 0,
			y: 0,
			width: 1,
			height: 1,
			data: [1, 2, 3, 4],
			fail: vi.fn(),
		})

		expect(publishedParams().canvasValidationError).toBe('data argument must be an Uint8ClampedArray')
	})

	it('validates putImageData dimensions and data length before crossing the bridge', () => {
		canvasPutImageData({
			canvasId: 'main',
			x: 0,
			y: 0,
			width: 2,
			height: 1,
			data: new Uint8ClampedArray([1, 2, 3, 4]),
			fail: vi.fn(),
		})

		expect(publishedParams().canvasValidationError).toContain('invalid data format')
	})

	it('rejects a pixel read that exceeds the shared bridge budget before it reaches render', () => {
		canvasGetImageData({
			canvasId: 'main',
			x: 0,
			y: 0,
			width: 4096,
			height: 4096,
			fail: vi.fn(),
		})

		expect(publishedParams().canvasValidationError).toContain('maximum transferable pixel data')
	})

	it('rejects oversized putImageData before converting the typed array to a boxed array', () => {
		const data = new Uint8ClampedArray(2048 * 1025 * 4)
		const arrayFrom = vi.spyOn(Array, 'from')

		try {
			canvasPutImageData({
				canvasId: 'main',
				x: 0,
				y: 0,
				width: 2048,
				height: 1025,
				data,
				fail: vi.fn(),
			})

			expect(publishedParams().canvasValidationError).toContain('maximum transferable pixel data')
			expect(arrayFrom).not.toHaveBeenCalled()
		}
		finally {
			arrayFrom.mockRestore()
		}
	})

	it('removes non-finite export crop values so the render side applies official omitted-value defaults', () => {
		canvasToTempFilePath({
			canvasId: 'main',
			x: Number.POSITIVE_INFINITY,
			y: Number.NaN,
			width: Number.POSITIVE_INFINITY,
			height: Number.NaN,
			success: vi.fn(),
		})

		const params = publishedParams()
		expect(params).not.toHaveProperty('x')
		expect(params).not.toHaveProperty('y')
		expect(params).not.toHaveProperty('width')
		expect(params).not.toHaveProperty('height')
		expect(JSON.stringify(params)).not.toContain('null')
	})

	it('marks non-finite export destination dimensions as invalid', () => {
		canvasToTempFilePath({
			canvasId: 'main',
			destWidth: Number.POSITIVE_INFINITY,
			destHeight: 10,
			fail: vi.fn(),
		})

		expect(publishedParams().canvasValidationError).toBe('destWidth must be finite')
		expect(publishedParams()).not.toHaveProperty('destWidth')
	})
})
