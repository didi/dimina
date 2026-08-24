// Canvas 位图会同时存在于 WebView、JS heap 和 JSON bridge。这里定义整个 canvas 子系统共同遵守的
// 支持边界；service 的提前拒绝用于省掉工作，render 的重复校验是兼容旧基础库和直发 bridge 消息的
// 权威防线。
export const MAX_CANVAS_IMAGE_BYTES = 32 * 1024 * 1024
export const CANVAS_RGBA_BYTES_PER_PIXEL = 4
export const MAX_CANVAS_DIMENSION = 4096
export const MAX_CANVAS_BITMAP_PIXELS = MAX_CANVAS_IMAGE_BYTES / CANVAS_RGBA_BYTES_PER_PIXEL

// 像素数组通过 JSON 发送时，每个 0...255 通道最坏需要三位数字和一个分隔符。限制的是编码后的
// bridge 峰值，而不是只看 Uint8ClampedArray 的紧凑字节数。
const MAX_JSON_BYTES_PER_CHANNEL = 4
export const MAX_CANVAS_TRANSFER_PIXELS = Math.floor(
	MAX_CANVAS_IMAGE_BYTES / CANVAS_RGBA_BYTES_PER_PIXEL / MAX_JSON_BYTES_PER_CHANNEL,
)

function checkedExtent(value) {
	const number = Number(value)
	if (!Number.isFinite(number)) return null
	const extent = Math.abs(Math.trunc(number))
	return Number.isSafeInteger(extent) ? extent : null
}

export function canvasPixelBudgetError(width, height, { allowZero = false, transferable = false } = {}) {
	const checkedWidth = checkedExtent(width)
	const checkedHeight = checkedExtent(height)
	if (checkedWidth === null || checkedHeight === null) {
		return 'pixel dimensions must be finite non-zero safe integers'
	}
	if (checkedWidth > MAX_CANVAS_DIMENSION || checkedHeight > MAX_CANVAS_DIMENSION) {
		return transferable
			? 'pixel dimensions exceed the maximum transferable pixel data'
			: 'pixel dimensions exceed the maximum canvas bitmap'
	}
	if (checkedWidth === 0 || checkedHeight === 0) {
		return allowZero ? null : 'pixel dimensions must be finite non-zero safe integers'
	}
	const maxPixels = transferable ? MAX_CANVAS_TRANSFER_PIXELS : MAX_CANVAS_BITMAP_PIXELS
	if (checkedWidth > Math.floor(maxPixels / checkedHeight)) {
		return transferable
			? 'pixel dimensions exceed the maximum transferable pixel data'
			: 'pixel dimensions exceed the maximum canvas bitmap'
	}
	return null
}

export function normalizeCanvasBitmapDimension(value, fallback) {
	if (value === undefined) return fallback
	const number = Number(value)
	if (!Number.isFinite(number) || number < 0) return fallback
	const dimension = Math.floor(number)
	if (!Number.isSafeInteger(dimension) || dimension > MAX_CANVAS_DIMENSION) {
		throw new RangeError('canvas dimensions exceed the maximum canvas bitmap')
	}
	return dimension
}
