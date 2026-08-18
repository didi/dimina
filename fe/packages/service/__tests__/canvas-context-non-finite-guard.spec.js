import { beforeEach, describe, expect, it, vi } from 'vitest'
import router from '../src/core/router.js'
import { CanvasContext } from '../src/api/core/ui/canvas/canvas-context.js'
import { drawCanvas } from '../src/api/core/ui/canvas/index.js'

/**
 * 契约：录制时按 W3C canvas 2D 语义处理非有限数——任何一条 action，只要它的数值参数里
 * 出现 NaN / Infinity / -Infinity，这条 action 就整条不录（静默忽略，不抛错、不打日志）。
 * 规则只适用于必需的数值参数；fillText/strokeText 的 maxWidth 与 drawImage 尾部的
 * width/height 是既有的可选参数，非有限时按既定契约降级保留调用，不在"整条不录"之列。
 *
 * 背景：逻辑层 -> 渲染层的消息通道在三端 native 宿主上走 JSON。
 * `JSON.stringify(NaN)` 变成 `null`，渲染层把 `null` 赋给 `globalAlpha` 等属性会得到 0
 * 而不是保留原值；`fillRect(NaN, ...)` 经 JSON 后变成 `fillRect(0, ...)`，
 * 把"规范要求忽略的调用"变成了"真的画了"。在录制阶段就挡掉非有限数，
 * 这类数据永远不会进入 JSON 通道，也就不会被腐蚀。
 */
describe('CanvasContext drops actions whose numeric args are non-finite', () => {
	it('drops fillRect/strokeRect/clearRect when any of the 4 numeric args is non-finite', () => {
		const context = new CanvasContext('canvas1')
		context.fillRect(Number.NaN, 0, 10, 10)
		context.fillRect(0, Number.NaN, 10, 10)
		context.fillRect(0, 0, Number.POSITIVE_INFINITY, 10)
		context.fillRect(0, 0, 10, Number.NEGATIVE_INFINITY)
		context.strokeRect(Number.NaN, 0, 10, 10)
		context.clearRect(0, 0, Number.POSITIVE_INFINITY, 10)

		expect(context.getActions()).toEqual([])
	})

	it('drops moveTo/lineTo when either coordinate is non-finite', () => {
		const context = new CanvasContext('canvas1')
		context.moveTo(Number.NaN, 0)
		context.moveTo(0, Number.POSITIVE_INFINITY)
		context.lineTo(Number.NEGATIVE_INFINITY, 0)

		expect(context.getActions()).toEqual([])
	})

	it('drops rect when any of the 4 numeric args is non-finite', () => {
		const context = new CanvasContext('canvas1')
		context.rect(Number.NaN, 0, 10, 10)
		context.rect(0, 0, Number.POSITIVE_INFINITY, 10)

		expect(context.getActions()).toEqual([])
	})

	it('drops arcTo when a coordinate or the radius is non-finite', () => {
		const context = new CanvasContext('canvas1')
		context.arcTo(Number.NaN, 1, 2, 3, 4)
		context.arcTo(1, 2, 3, 4, Number.POSITIVE_INFINITY)

		expect(context.getActions()).toEqual([])
	})

	it('drops quadraticCurveTo/bezierCurveTo when a control point coordinate is non-finite', () => {
		const context = new CanvasContext('canvas1')
		context.quadraticCurveTo(1, Number.NaN, 3, 4)
		context.bezierCurveTo(1, 2, 3, 4, 5, Number.NEGATIVE_INFINITY)

		expect(context.getActions()).toEqual([])
	})

	it('drops arc when the radius or either angle is non-finite', () => {
		const context = new CanvasContext('canvas1')
		context.arc(1, 2, Number.NaN, 0, Math.PI)
		context.arc(1, 2, 3, 0, Number.POSITIVE_INFINITY)

		expect(context.getActions()).toEqual([])
	})

	// x / y 是 fillText / strokeText 的必需定位参数——maxWidth 是可选的且有既定的降级契约，
	// 不在这里测（见下面单独的"既定契约保持不变"分组）。
	it('drops fillText/strokeText when the required x or y position is non-finite', () => {
		const context = new CanvasContext('canvas1')
		context.fillText('hi', Number.NaN, 20)
		context.strokeText('hi', 10, Number.POSITIVE_INFINITY)

		expect(context.getActions()).toEqual([])
	})

	it('drops drawImage (3-arg target-only form) when the required target position is non-finite', () => {
		const context = new CanvasContext('canvas1')
		context.drawImage('a.png', Number.NaN, 10)

		expect(context.getActions()).toEqual([])
	})

	// 4 个数字参数按现有重载判定规则会被识别成"目标矩形"形式，dx/dy 是这个形式里的必需定位参数
	// （dWidth/dHeight 才是可选的降级对象，见下面单独的"既定契约保持不变"分组）。
	it('drops drawImage (target-rect form) when the required target position is non-finite, even though the width/height are finite', () => {
		const context = new CanvasContext('canvas1')
		context.drawImage('a.png', Number.NaN, 20, 30, 40)

		expect(context.getActions()).toEqual([])
	})

	it('drops drawImage (9-arg full form) when the required target position is non-finite, even though the source rect is finite', () => {
		const context = new CanvasContext('canvas1')
		context.drawImage('a.png', 1, 2, 3, 4, Number.NaN, 6, 7, 8)

		expect(context.getActions()).toEqual([])
	})
})

describe('CanvasContext drops transform actions with non-finite args and leaves the matrix untouched', () => {
	it('drops scale/rotate/translate when an arg is non-finite', () => {
		const context = new CanvasContext('canvas1')
		context.scale(Number.NaN, 2)
		context.rotate(Number.POSITIVE_INFINITY)
		context.translate(Number.NEGATIVE_INFINITY, 5)

		expect(context.getActions()).toEqual([])
	})

	it('a rejected scale() does not corrupt the transform matrix that a prior legit scale() built', () => {
		const context = new CanvasContext('canvas1')
		context.scale(2, 3)
		context.getActions()
		context.scale(Number.NaN, 5)

		expect(context.getTransform()).toEqual({ a: 2, b: 0, c: 0, d: 3, e: 0, f: 0 })
		expect(context.getActions()).toEqual([])
	})

	it('drops transform()/setTransform() when any of the 6 args is non-finite, and leaves the matrix at identity', () => {
		const context = new CanvasContext('canvas1')
		context.transform(1, 2, Number.POSITIVE_INFINITY, 4, 5, 6)
		context.setTransform(1, 2, 3, 4, 5, Number.NEGATIVE_INFINITY)

		expect(context.getActions()).toEqual([])
		expect(context.getTransform()).toEqual({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 })
	})

	it('a rejected setTransform() does not overwrite the matrix set by a prior legit setTransform()', () => {
		const context = new CanvasContext('canvas1')
		context.setTransform(2, 0, 0, 2, 5, 5)
		context.getActions()
		context.setTransform(Number.NaN, 0, 0, 2, 5, 5)

		expect(context.getTransform()).toEqual({ a: 2, b: 0, c: 0, d: 2, e: 5, f: 5 })
		expect(context.getActions()).toEqual([])
	})
})

describe('CanvasContext drops numeric-state action when the value is non-finite', () => {
	it('drops setGlobalAlpha/setLineWidth/setMiterLimit when the value is non-finite', () => {
		const context = new CanvasContext('canvas1')
		context.setGlobalAlpha(Number.NaN)
		context.setLineWidth(Number.POSITIVE_INFINITY)
		context.setMiterLimit(Number.NEGATIVE_INFINITY)

		expect(context.getActions()).toEqual([])
	})

	it('drops setShadow when any of offsetX/offsetY/blur is non-finite, even though color is fine', () => {
		const context = new CanvasContext('canvas1')
		context.setShadow(Number.NaN, 0, 1, 'red')

		expect(context.getActions()).toEqual([])
	})

	// setFontSize 已经有 Number.isFinite 判定（不改 state、不录 action），这条预期就是绿的。
	it('drops setFontSize when the size is non-finite', () => {
		const context = new CanvasContext('canvas1')
		context.setFontSize(Number.NaN)

		expect(context.getActions()).toEqual([])
	})
})

describe('CanvasContext drops property-setter action when the assigned value is non-finite', () => {
	it('drops globalAlpha/lineWidth/miterLimit assignment when non-finite', () => {
		const context = new CanvasContext('canvas1')
		context.globalAlpha = Number.NaN
		context.lineWidth = Number.POSITIVE_INFINITY
		context.miterLimit = Number.NEGATIVE_INFINITY

		expect(context.getActions()).toEqual([])
	})

	it('drops shadowBlur/shadowOffsetX/shadowOffsetY assignment when non-finite', () => {
		const context = new CanvasContext('canvas1')
		context.shadowBlur = Number.NaN
		context.shadowOffsetX = Number.POSITIVE_INFINITY
		context.shadowOffsetY = Number.NEGATIVE_INFINITY

		expect(context.getActions()).toEqual([])
	})

	it('drops lineDashOffset assignment when non-finite', () => {
		const context = new CanvasContext('canvas1')
		context.lineDashOffset = Number.NaN

		expect(context.getActions()).toEqual([])
	})
})

describe('CanvasContext drops the action when an array parameter contains a non-finite number', () => {
	it('drops setLineDash when the pattern array itself contains NaN or Infinity', () => {
		const context = new CanvasContext('canvas1')
		context.setLineDash([10, Number.NaN])
		context.setLineDash([Number.POSITIVE_INFINITY, 5], 0)

		expect(context.getActions()).toEqual([])
	})
})

describe('CanvasContext still records finite extreme values (the guard must not over-trigger)', () => {
	it('records fillRect verbatim for MAX_SAFE_INTEGER, 1e308, -1e308, 0, negative and MIN_VALUE', () => {
		const context = new CanvasContext('canvas1')
		context.fillRect(Number.MAX_SAFE_INTEGER, 0, 10, 10)
		context.fillRect(1e308, -1e308, 10, 10)
		context.fillRect(0, 0, 0, 0)
		context.fillRect(-5, Number.MIN_VALUE, 10, 10)

		expect(context.getActions()).toEqual([
			{ type: 'fillPath', args: [[{ type: 'rect', args: [Number.MAX_SAFE_INTEGER, 0, 10, 10] }]] },
			{ type: 'fillPath', args: [[{ type: 'rect', args: [1e308, -1e308, 10, 10] }]] },
			{ type: 'fillPath', args: [[{ type: 'rect', args: [0, 0, 0, 0] }]] },
			{ type: 'fillPath', args: [[{ type: 'rect', args: [-5, Number.MIN_VALUE, 10, 10] }]] },
		])
	})

	it('records moveTo/lineTo verbatim for large finite coordinates', () => {
		const context = new CanvasContext('canvas1')
		context.moveTo(-1e308, Number.MAX_SAFE_INTEGER)
		context.lineTo(1e308, -Number.MAX_SAFE_INTEGER)
		context.stroke()

		expect(context.getActions()).toEqual([{
			type: 'strokePath',
			args: [[
				{ type: 'moveTo', args: [-1e308, Number.MAX_SAFE_INTEGER] },
				{ type: 'lineTo', args: [1e308, -Number.MAX_SAFE_INTEGER] },
			]],
		}])
	})

	it('records scale() and updates the transform matrix for large finite factors', () => {
		const context = new CanvasContext('canvas1')
		context.scale(1e308, 1e300)

		expect(context.getActions()).toEqual([{ type: 'scale', args: [1e308, 1e300] }])
		expect(context.getTransform()).toEqual({ a: 1e308, b: 0, c: 0, d: 1e300, e: 0, f: 0 })
	})

	it('records setGlobalAlpha/setLineWidth verbatim for large finite values', () => {
		const context = new CanvasContext('canvas1')
		context.setGlobalAlpha(1e308)
		context.setLineWidth(Number.MIN_VALUE)

		expect(context.getActions()).toEqual([
			{ type: 'setGlobalAlpha', args: [1e308] },
			{ type: 'setLineWidth', args: [Number.MIN_VALUE] },
		])
	})

	it('records setLineDash verbatim when both the pattern and the offset are finite', () => {
		const context = new CanvasContext('canvas1')
		context.setLineDash([10, 20], 5)

		expect(context.getActions()).toEqual([{ type: 'setLineDash', args: [[10, 20], 5] }])
	})
})

describe('CanvasContext keeps its existing optional-arg degradation contract untouched', () => {
	// maxWidth 是可选参数，非有限时既定行为是丢掉 maxWidth、保留这次绘制（降级成 3 参形式）。
	it('keeps fillText/strokeText when only the optional maxWidth is non-finite, dropping just maxWidth', () => {
		const context = new CanvasContext('canvas1')
		context.fillText('hi', 10, 20, Number.NaN)
		context.strokeText('hi', 30, 40, Number.POSITIVE_INFINITY)

		expect(context.getActions()).toEqual([
			{ type: 'fillText', args: ['hi', 10, 20] },
			{ type: 'strokeText', args: ['hi', 30, 40] },
		])
	})

	// dWidth/dHeight 是尾部可选参数，非有限时既定行为是退化成只保留目标位置的 3 参形式。
	it('keeps drawImage when only the optional width/height is non-finite, dropping just the size', () => {
		const context = new CanvasContext('canvas1')
		context.drawImage('a.png', 10, 20, Number.NaN, 40)

		expect(context.getActions()).toEqual([{ type: 'drawImage', args: ['a.png', 10, 20] }])
	})
})

describe('CanvasContext leaves non-numeric parameters untouched by the non-finite guard', () => {
	it('records setFillStyle/setLineCap/setTextAlign verbatim (no numeric args involved)', () => {
		const context = new CanvasContext('canvas1')
		context.setFillStyle('red')
		context.setLineCap('round')
		context.setTextAlign('center')

		expect(context.getActions()).toEqual([
			{ type: 'setFillStyle', args: ['red'] },
			{ type: 'setLineCap', args: ['round'] },
			{ type: 'setTextAlign', args: ['center'] },
		])
	})

	it('records setFillStyle verbatim for a gradient style object', () => {
		const context = new CanvasContext('canvas1')
		const gradient = context.createLinearGradient(0, 0, 10, 10)
		context.getActions()
		context.setFillStyle(gradient)

		expect(context.getActions()).toEqual([
			{
				type: 'setFillStyle',
				args: [{ __canvasStyle: 'gradient', type: 'linear', data: [0, 0, 10, 10], colorStop: [] }],
			},
		])
	})

	it('does not mistake the text content "NaN" for the numeric literal NaN', () => {
		const context = new CanvasContext('canvas1')
		context.fillText('NaN', 10, 20)

		expect(context.getActions()).toEqual([{ type: 'fillText', args: ['NaN', 10, 20] }])
	})
})

/**
 * 同一条不变量在 `wx.drawCanvas()` 这个入口上的缺口：开发者可以绕过 `CanvasContext`，
 * 直接把手搓的 actions 数组传给 drawCanvas()。这条路径发给渲染层的 payload 里
 * 同样不能出现非有限数——判据与 CanvasContext 录制时完全一致：
 * 一条 action 的 args（含数组参数内部元素）里只要有 NaN / Infinity / -Infinity，整条剔除；
 * 其余 action 原样保留、顺序不变。
 */
describe('drawCanvas() strips actions with non-finite args from a manually supplied actions array', () => {
	beforeEach(() => {
		router.setInitId('page_test')
		globalThis.DiminaServiceBridge.publish = vi.fn()
	})

	function publishedActions() {
		const [, message] = globalThis.DiminaServiceBridge.publish.mock.calls[0]
		return message.body.params.actions
	}

	it('drops the action containing a non-finite arg, keeping the other actions in order', () => {
		drawCanvas({
			canvasId: 'main-canvas',
			actions: [
				{ type: 'fillRect', args: [0, 0, 10, 10] },
				{ type: 'setGlobalAlpha', args: [Number.NaN] },
				{ type: 'strokeRect', args: [1, 2, 3, 4] },
			],
		})

		expect(publishedActions()).toEqual([
			{ type: 'fillRect', args: [0, 0, 10, 10] },
			{ type: 'strokeRect', args: [1, 2, 3, 4] },
		])
	})

	it('drops the action when a non-finite number is nested inside an array arg', () => {
		drawCanvas({
			canvasId: 'main-canvas',
			actions: [
				{ type: 'setLineDash', args: [[10, Number.NaN], 0] },
				{ type: 'setLineWidth', args: [2] },
			],
		})

		expect(publishedActions()).toEqual([{ type: 'setLineWidth', args: [2] }])
	})

	it('keeps finite extreme values and non-numeric args untouched', () => {
		drawCanvas({
			canvasId: 'main-canvas',
			actions: [
				{ type: 'fillRect', args: [Number.MAX_SAFE_INTEGER, -1e308, 0, Number.MIN_VALUE] },
				{ type: 'setFillStyle', args: ['red'] },
				{ type: 'setLineCap', args: ['round'] },
			],
		})

		expect(publishedActions()).toEqual([
			{ type: 'fillRect', args: [Number.MAX_SAFE_INTEGER, -1e308, 0, Number.MIN_VALUE] },
			{ type: 'setFillStyle', args: ['red'] },
			{ type: 'setLineCap', args: ['round'] },
		])
	})

	it('does not throw when actions is missing, not an array, or empty, and still publishes other fields', () => {
		expect(() => drawCanvas({ canvasId: 'c1' })).not.toThrow()
		expect(() => drawCanvas({ canvasId: 'c2', actions: 'not-an-array' })).not.toThrow()
		expect(() => drawCanvas({ canvasId: 'c3', actions: [] })).not.toThrow()

		const [, message] = globalThis.DiminaServiceBridge.publish.mock.calls[2]
		expect(message.body.params.canvasId).toBe('c3')
		expect(message.body.params.actions).toEqual([])
	})

	it('leaves canvasId/reserve/moduleId untouched while filtering actions', () => {
		drawCanvas({
			canvasId: 'main-canvas',
			reserve: true,
			moduleId: 'component_9',
			actions: [
				{ type: 'moveTo', args: [Number.POSITIVE_INFINITY, 0] },
				{ type: 'lineTo', args: [5, 5] },
			],
		})

		const [, message] = globalThis.DiminaServiceBridge.publish.mock.calls[0]
		expect(message.body.params.canvasId).toBe('main-canvas')
		expect(message.body.params.reserve).toBe(true)
		expect(message.body.params.moduleId).toBe('component_9')
		expect(message.body.params.actions).toEqual([{ type: 'lineTo', args: [5, 5] }])
	})
})
