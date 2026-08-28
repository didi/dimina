import { beforeEach, describe, expect, it, vi } from 'vitest'
import router from '../src/core/router.js'
import { CanvasContext } from '../src/api/core/ui/canvas/canvas-context.js'
import { drawCanvas } from '../src/api/core/ui/canvas/index.js'

/**
 * 三个补丁点，都是「非有限数不得进入录制的 action」这条不变量在原实现里漏掉的角落。
 *
 * 缺口一：guard 只判 `typeof value === 'number' && !Number.isFinite(value)`，`undefined` 穿透。
 * `JSON.stringify({ args: [undefined] })` 会把 `undefined` 变成 `null`，渲染层拿到 `null` 后
 * 折成 0，跟 NaN 造成的真机全透明是同一个故障——所以 `undefined` 必须和 NaN/Infinity 同等对待。
 * `null` 不在此列：JSON 和结构化克隆两端对 `null` 的处理是一致的（都保持 `null`），
 * 不是跨端分裂，因此 `null` 必须继续被当成合法输入照常录制，不能被guard拦。
 *
 * 缺口二：guard 只递归数组，不看普通对象。`setFillStyle(gradient)` 的 args 是
 * `serializeCanvasStyle()` 产出的对象（`{ __canvasStyle, type, data:[...], colorStop:[[...]] }`），
 * 非有限数或 undefined 混进 `data` 坐标或 `colorStop` 偏移时guard 看不见，照样会穿透进 payload。
 *
 * 缺口三：drawCanvas() 的过滤器 `hasNonFiniteNumber(action?.args ?? [])` 假定 args 一定是数组，
 * 遇到 `args` 本身不是数组（数字、普通对象等畸形 action）会直接 `values.some is not a function` 抛出，
 * 让整批 actions 都发不出去。这里选定的契约：单条 action 的 args 形状不合法时，
 * 视为该条 action 本身不可信，整条丢弃（不转发给渲染层），不让它拖垮同批次里其余合法的 action。
 */
describe('CanvasContext treats undefined the same as NaN/Infinity, but keeps null as legal', () => {
	it('drops setGlobalAlpha/setLineWidth when the value is undefined', () => {
		const context = new CanvasContext('canvas1')
		context.setGlobalAlpha(undefined)
		context.setLineWidth(undefined)

		expect(context.getActions()).toEqual([])
	})

	it('drops fillRect/moveTo when a required coordinate is undefined', () => {
		const context = new CanvasContext('canvas1')
		context.fillRect(undefined, 0, 10, 10)
		context.moveTo(undefined, 5)

		expect(context.getActions()).toEqual([])
	})

	it('a rejected scale()/setTransform() with an undefined arg does not record and does not corrupt the matrix', () => {
		const context = new CanvasContext('canvas1')
		context.scale(2, 3)
		context.getActions()
		context.scale(undefined, 5)
		context.setTransform(1, 0, 0, undefined, 0, 0)

		expect(context.getTransform()).toEqual({ a: 2, b: 0, c: 0, d: 3, e: 0, f: 0 })
		expect(context.getActions()).toEqual([])
	})

	it('drops setLineDash when the pattern array contains undefined', () => {
		const context = new CanvasContext('canvas1')
		context.setLineDash([10, undefined])

		expect(context.getActions()).toEqual([])
	})

	it('drops the globalAlpha property-setter assignment when the value is undefined', () => {
		const context = new CanvasContext('canvas1')
		context.globalAlpha = undefined

		expect(context.getActions()).toEqual([])
	})

	it('keeps setGlobalAlpha/fillRect/setLineDash verbatim when the value is null', () => {
		const context = new CanvasContext('canvas1')
		context.setGlobalAlpha(null)
		context.fillRect(0, 0, null, 10)
		context.setLineDash([10, null], 0)

		expect(context.getActions()).toEqual([
			{ type: 'setGlobalAlpha', args: [null] },
			{ type: 'fillPath', args: [[{ type: 'rect', args: [0, 0, null, 10] }]] },
			{ type: 'setLineDash', args: [[10, null], 0] },
		])
	})
})

describe('CanvasContext looks inside serialized gradient style objects for non-finite/undefined values', () => {
	it('drops setFillStyle when a linear gradient coordinate is non-finite', () => {
		const context = new CanvasContext('canvas1')
		const gradient = context.createLinearGradient(Number.NaN, 0, 100, 0)
		gradient.addColorStop(0, '#f00')
		context.setFillStyle(gradient)

		expect(context.getActions()).toEqual([])
	})

	it('drops setStrokeStyle when a circular gradient coordinate is non-finite', () => {
		const context = new CanvasContext('canvas1')
		const gradient = context.createCircularGradient(0, 0, Number.POSITIVE_INFINITY)
		context.setStrokeStyle(gradient)

		expect(context.getActions()).toEqual([])
	})

	it('drops setFillStyle when a gradient colorStop offset is non-finite or undefined', () => {
		const context = new CanvasContext('canvas1')
		const withNaNStop = context.createLinearGradient(0, 0, 100, 0)
		withNaNStop.addColorStop(Number.NaN, '#f00')
		context.setFillStyle(withNaNStop)

		const withUndefinedStop = context.createLinearGradient(0, 0, 100, 0)
		withUndefinedStop.addColorStop(undefined, '#00f')
		context.setFillStyle(withUndefinedStop)

		expect(context.getActions()).toEqual([])
	})

	it('records setFillStyle verbatim for a well-formed gradient (guard must not over-trigger on valid gradients)', () => {
		const context = new CanvasContext('canvas1')
		const gradient = context.createLinearGradient(0, 0, 100, 0)
		gradient.addColorStop(0, '#f00')
		gradient.addColorStop(1, '#00f')
		context.setFillStyle(gradient)

		expect(context.getActions()).toEqual([
			{
				type: 'setFillStyle',
				args: [{
					__canvasStyle: 'gradient',
					type: 'linear',
					data: [0, 0, 100, 0],
					colorStop: [[0, '#f00'], [1, '#00f']],
				}],
			},
		])
	})
})

describe('drawCanvas() does not throw when a single action has a malformed (non-array) args', () => {
	beforeEach(() => {
		router.setInitId('page_test')
		globalThis.DiminaServiceBridge.publish = vi.fn()
	})

	function publishedActions() {
		const [, message] = globalThis.DiminaServiceBridge.publish.mock.calls[0]
		return message.body.params.actions
	}

	it('drops an action whose args is a bare number, without throwing, and keeps the rest of the batch', () => {
		expect(() => drawCanvas({
			canvasId: 'main-canvas',
			actions: [
				{ type: 'fillRect', args: 5 },
				{ type: 'strokeRect', args: [1, 2, 3, 4] },
			],
		})).not.toThrow()

		expect(publishedActions()).toEqual([{ type: 'strokeRect', args: [1, 2, 3, 4] }])
	})

	it('drops an action whose args is a plain object, without throwing, and keeps the rest of the batch', () => {
		expect(() => drawCanvas({
			canvasId: 'main-canvas',
			actions: [
				{ type: 'clearRect', args: {} },
				{ type: 'setLineWidth', args: [2] },
			],
		})).not.toThrow()

		expect(publishedActions()).toEqual([{ type: 'setLineWidth', args: [2] }])
	})
})
