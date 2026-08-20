// canvasToTempFilePath 会先在渲染线程创建完整目标位图，再编码并跨 bridge 传给 native。
// 两个限制来自不同边界：总像素数约束这条链的 32 MiB 峰值，单边 4096 对齐项目所支持的
// 最低 WebView 能力（iOS WebKit 的公开 canvas 单边上限）。只检查乘积会放过极端长条画布，
// 这些画布可能在总字节数以内，却被引擎判成不可用。
import { MAX_CANVAS_BITMAP_PIXELS, MAX_CANVAS_DIMENSION } from '@dimina/common'

export const MAX_CANVAS_EXPORT_PIXELS = MAX_CANVAS_BITMAP_PIXELS
export const MAX_CANVAS_EXPORT_DIMENSION = MAX_CANVAS_DIMENSION

function positiveFiniteOrFallback(value, fallback) {
	const number = Number(value)
	return Number.isFinite(number) && number > 0 ? number : fallback
}

export function resolveCanvasExportSize({
	destHeight,
	destWidth,
	fallbackHeight,
	fallbackWidth,
	pixelRatio,
}) {
	const scale = positiveFiniteOrFallback(pixelRatio, 1)
	// HTMLCanvasElement.width/height 是整数。这里显式完成转换，避免让 WebIDL 对超大数取模，
	// 也让检查值、实际分配值和 drawImage 目标值始终一致。
	const width = Math.trunc(positiveFiniteOrFallback(destWidth, fallbackWidth * scale))
	const height = Math.trunc(positiveFiniteOrFallback(destHeight, fallbackHeight * scale))

	if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
		throw new Error('destination size is invalid')
	}
	if (width > MAX_CANVAS_EXPORT_DIMENSION || height > MAX_CANVAS_EXPORT_DIMENSION
		|| width * height > MAX_CANVAS_EXPORT_PIXELS) {
		throw new Error('destination size exceeds the maximum exportable image')
	}

	return { height, width }
}
