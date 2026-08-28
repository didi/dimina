import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import router from '../src/core/router.js'
import { createContext } from '../src/api/core/ui/canvas/index.js'


describe('legacy CanvasContext api', () => {
	beforeEach(() => {
		router.setInitId('page_test')
		globalThis.DiminaServiceBridge.publish = vi.fn()
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('drawing methods return the context itself for chaining', () => {
		const context = createContext()
		const result = context.beginPath().moveTo(0, 0).lineTo(1, 1).stroke()

		expect(result).toBe(context)
	})

	describe('path snapshots', () => {
		it('records path commands inside fillPath instead of replaying a mutable browser path early', () => {
			const context = createContext()
			context.beginPath()
			context.moveTo(1, 2)
			context.lineTo(3, 4)
			context.rect(5, 6, 7, 8)
			context.arcTo(1, 2, 3, 4, 5)
			context.quadraticCurveTo(1, 2, 3, 4)
			context.bezierCurveTo(1, 2, 3, 4, 5, 6)
			context.closePath()
			context.fill()

			expect(context.getActions()).toEqual([{
				type: 'fillPath',
				args: [[
					{ type: 'moveTo', args: [1, 2] },
					{ type: 'lineTo', args: [3, 4] },
					{ type: 'rect', args: [5, 6, 7, 8] },
					{ type: 'arcTo', args: [1, 2, 3, 4, 5] },
					{ type: 'quadraticCurveTo', args: [1, 2, 3, 4] },
					{ type: 'bezierCurveTo', args: [1, 2, 3, 4, 5, 6] },
					{ type: 'closePath', args: [] },
				]],
			}])
		})

		it('arc snapshots default and explicit counterclockwise flags', () => {
			const context = createContext()
			context.arc(1, 2, 3, 0, Math.PI)
			context.arc(4, 5, 6, 0, Math.PI, true)
			context.stroke()

			expect(context.getActions()[0].args[0]).toEqual([
				{ type: 'arc', args: [1, 2, 3, 0, Math.PI, false] },
				{ type: 'arc', args: [4, 5, 6, 0, Math.PI, true] },
			])
		})

		it('clears the current path together with actions after draw extraction', () => {
			const context = createContext()
			context.rect(0, 0, 10, 10)
			context.fill()
			context.getActions()
			context.fill()

			expect(context.getActions()).toEqual([{ type: 'fillPath', args: [[]] }])
		})
	})

	describe('drawing methods', () => {
		it('captures path drawing as snapshots and leaves clearRect as a direct action', () => {
			const context = createContext()
			context.fill()
			context.stroke()
			context.clip()
			context.clearRect(1, 2, 3, 4)
			context.fillRect(1, 2, 3, 4)
			context.strokeRect(1, 2, 3, 4)

			expect(context.getActions()).toEqual([
				{ type: 'fillPath', args: [[]] },
				{ type: 'strokePath', args: [[]] },
				{ type: 'clip', args: [[]] },
				{ type: 'clearRect', args: [1, 2, 3, 4] },
				{ type: 'fillPath', args: [[{ type: 'rect', args: [1, 2, 3, 4] }]] },
				{ type: 'strokePath', args: [[{ type: 'rect', args: [1, 2, 3, 4] }]] },
			])
		})

		it('fillText coerces a non-string text argument to a string', () => {
			const context = createContext()
			context.fillText(123, 1, 2)

			expect(context.getActions()).toEqual([{ type: 'fillText', args: ['123', 1, 2] }])
		})

		it('fillText appends maxWidth only when it is a number', () => {
			const context = createContext()
			context.fillText('hi', 1, 2, 50)

			expect(context.getActions()).toEqual([{ type: 'fillText', args: ['hi', 1, 2, 50] }])
		})

		it.each([
			['omitted', undefined],
			['a non-number string', 'not-a-number'],
		])('fillText drops maxWidth when it is %s', (_label, maxWidth) => {
			const context = createContext()
			context.fillText('hi', 1, 2, maxWidth)
			const [action] = context.getActions()

			expect(action.type).toBe('fillText')
			expect(action.args).toHaveLength(3)
			expect(action.args).toEqual(['hi', 1, 2])
		})

		it('strokeText coerces text and appends maxWidth only when it is a number', () => {
			const context = createContext()
			context.strokeText(123, 1, 2)
			context.strokeText('hi', 3, 4, 50)
			context.strokeText('hi', 5, 6, 'nope')

			expect(context.getActions()).toEqual([
				{ type: 'strokeText', args: ['123', 1, 2] },
				{ type: 'strokeText', args: ['hi', 3, 4, 50] },
				{ type: 'strokeText', args: ['hi', 5, 6] },
			])
		})
	})

	describe('fillText / strokeText maxWidth numeric normalization', () => {
		// Real canvas draws nothing at all for a NaN/Infinity maxWidth (the text vanishes
		// silently), and accepts a numeric string as a real width limit. A plain
		// `typeof maxWidth === 'number'` check gets both of these backwards: it lets NaN
		// through as if it were a valid width, and rejects '100' as if it were not a width.

		it.each(['fillText', 'strokeText'])('%s drops maxWidth for null and undefined', (method) => {
			const context = createContext()
			context[method]('hi', 1, 2, null)
			context[method]('hi', 3, 4, undefined)

			expect(context.getActions()).toEqual([
				{ type: method, args: ['hi', 1, 2] },
				{ type: method, args: ['hi', 3, 4] },
			])
		})

		it.each(['fillText', 'strokeText'])('%s drops maxWidth when it is NaN, instead of passing NaN through and making the text vanish', (method) => {
			const context = createContext()
			context[method]('hi', 1, 2, Number.NaN)

			expect(context.getActions()).toEqual([{ type: method, args: ['hi', 1, 2] }])
		})

		it.each(['fillText', 'strokeText'])('%s drops maxWidth when it is Infinity', (method) => {
			const context = createContext()
			context[method]('hi', 1, 2, Number.POSITIVE_INFINITY)

			expect(context.getActions()).toEqual([{ type: method, args: ['hi', 1, 2] }])
		})

		it.each(['fillText', 'strokeText'])('%s accepts a numeric string maxWidth, normalizing it to a number instead of dropping it', (method) => {
			const context = createContext()
			context[method]('hi', 1, 2, '100')

			expect(context.getActions()).toEqual([{ type: method, args: ['hi', 1, 2, 100] }])
		})

		it.each(['fillText', 'strokeText'])('%s still accepts a plain finite number maxWidth', (method) => {
			const context = createContext()
			context[method]('hi', 1, 2, 50)

			expect(context.getActions()).toEqual([{ type: method, args: ['hi', 1, 2, 50] }])
		})
	})

	describe('drawImage overload selection', () => {
		it('records the 3-arg form', () => {
			const context = createContext()
			context.drawImage('a.png', 10, 20)

			expect(context.getActions()).toEqual([{ type: 'drawImage', args: ['a.png', 10, 20] }])
		})

		it('records the 5-arg form', () => {
			const context = createContext()
			context.drawImage('a.png', 10, 20, 30, 40)

			expect(context.getActions()).toEqual([{ type: 'drawImage', args: ['a.png', 10, 20, 30, 40] }])
		})

		it('records the 9-arg form', () => {
			const context = createContext()
			context.drawImage('a.png', 1, 2, 3, 4, 5, 6, 7, 8)

			expect(context.getActions()).toEqual([{ type: 'drawImage', args: ['a.png', 1, 2, 3, 4, 5, 6, 7, 8] }])
		})

		// The overload is picked by whether the trailing positions actually hold finite
		// numbers, not by how many arguments the caller happened to pass. Real canvas turns a
		// non-finite dWidth/dHeight into NaN and refuses to draw anything at all, whereas
		// degrading to the 3-arg form draws the image at its natural size — so getting this
		// backwards (treating "an argument slot was passed, even as undefined" as enough to
		// keep the 5-arg form) silently blanks out images whenever w/h data is missing upstream.

		it('degrades to the 3-arg form when the trailing width/height are both undefined, dropping them instead of passing them through as NaN', () => {
			const context = createContext()
			context.drawImage('a.png', 1, 2, undefined, undefined)

			expect(context.getActions()).toEqual([{ type: 'drawImage', args: ['a.png', 1, 2] }])
		})

		it('degrades to the 3-arg form when only one of the trailing width/height is a finite number', () => {
			const context = createContext()
			context.drawImage('a.png', 10, 20, 30, undefined)

			expect(context.getActions()).toEqual([{ type: 'drawImage', args: ['a.png', 10, 20] }])
		})

		it('degrades to the 3-arg form when a trailing width/height is explicitly NaN', () => {
			const context = createContext()
			context.drawImage('a.png', 1, 2, Number.NaN, Number.NaN)

			expect(context.getActions()).toEqual([{ type: 'drawImage', args: ['a.png', 1, 2] }])
		})

		it('extracts the string path from an image object exposing src', () => {
			const context = createContext()
			context.drawImage({ src: 'foo.png' }, 0, 0)

			expect(context.getActions()[0].args[0]).toBe('foo.png')
		})

		it('extracts the string path from an image object exposing _src', () => {
			const context = createContext()
			context.drawImage({ _src: 'bar.png' }, 0, 0)

			expect(context.getActions()[0].args[0]).toBe('bar.png')
		})
	})

	describe('transform matrix', () => {
		it('starts at the identity matrix', () => {
			const context = createContext()

			expect(context.getTransform()).toEqual({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 })
		})

		it('setTransform replaces the matrix directly', () => {
			const context = createContext()
			context.setTransform(2, 0, 0, 3, 10, 20)

			expect(context.getTransform()).toEqual({ a: 2, b: 0, c: 0, d: 3, e: 10, f: 20 })
			expect(context.getActions()).toEqual([{ type: 'setTransform', args: [2, 0, 0, 3, 10, 20] }])
		})

		it('transform left-multiplies onto the current matrix, keeping the b/c cross terms distinct', () => {
			const context = createContext()
			context.setTransform(0, 1, -1, 0, 0, 0)
			context.transform(1, 2, 3, 4, 5, 6)

			expect(context.getTransform()).toEqual({ a: -2, b: 1, c: -4, d: 3, e: -6, f: 5 })
		})

		it('scale only multiplies a/b by scaleWidth and c/d by scaleHeight, leaving e/f untouched', () => {
			const context = createContext()
			context.setTransform(2, 3, 4, 5, 6, 7)
			context.scale(10, 100)

			expect(context.getTransform()).toEqual({ a: 20, b: 30, c: 400, d: 500, e: 6, f: 7 })
		})

		it('rotate and translate do not update _transform, matching the official implementation', () => {
			const context = createContext()
			context.setTransform(2, 3, 4, 5, 6, 7)
			const before = context.getTransform()
			context.rotate(Math.PI / 2)
			context.translate(100, 200)

			expect(context.getTransform()).toEqual(before)
			expect(context.getActions()).toEqual([
				{ type: 'setTransform', args: [2, 3, 4, 5, 6, 7] },
				{ type: 'rotate', args: [Math.PI / 2] },
				{ type: 'translate', args: [100, 200] },
			])
		})
	})

	describe('state setter methods and properties', () => {
		it.each([
			['fillStyle', 'setFillStyle', 'red'],
			['strokeStyle', 'setStrokeStyle', 'blue'],
			['globalAlpha', 'setGlobalAlpha', 0.5],
			['lineCap', 'setLineCap', 'round'],
			['lineJoin', 'setLineJoin', 'bevel'],
			['lineWidth', 'setLineWidth', 3],
			['miterLimit', 'setMiterLimit', 10],
			['textAlign', 'setTextAlign', 'center'],
			['textBaseline', 'setTextBaseline', 'middle'],
		])('%s = value produces the exact same action as %s(value)', (prop, method, value) => {
			const viaProperty = createContext()
			viaProperty[prop] = value
			const viaMethod = createContext()
			viaMethod[method](value)

			expect(viaProperty.getActions()).toEqual(viaMethod.getActions())
		})

		// globalCompositeOperation / lineDashOffset / shadowBlur / shadowColor / shadowOffsetX / shadowOffsetY
		// exist only as property accessors in the official implementation — there is no setXxx method
		// counterpart for these six, unlike the group above. The property assignment is the only way
		// to produce the action.
		it.each([
			['globalCompositeOperation', 'setGlobalCompositeOperation', 'source-over'],
			['lineDashOffset', 'setLineDashOffset', 5],
			['shadowBlur', 'setShadowBlur', 2],
			['shadowColor', 'setShadowColor', '#000'],
			['shadowOffsetX', 'setShadowOffsetX', 1],
			['shadowOffsetY', 'setShadowOffsetY', 2],
		])('%s = value produces a %s action', (prop, actionType, value) => {
			const context = createContext()
			context[prop] = value

			expect(context.getActions()).toEqual([{ type: actionType, args: [value] }])
		})

		it.each([
			'setGlobalCompositeOperation', 'setLineDashOffset', 'setShadowBlur',
			'setShadowColor', 'setShadowOffsetX', 'setShadowOffsetY',
		])('%s does not exist as a method, matching the official implementation which only exposes it as a property setter', (method) => {
			const context = createContext()

			expect(typeof context[method]).toBe('undefined')
		})

		it.each([
			'fillStyle', 'strokeStyle', 'globalAlpha', 'lineCap', 'lineJoin', 'lineWidth',
			'miterLimit', 'textAlign', 'textBaseline', 'globalCompositeOperation',
			'lineDashOffset', 'shadowBlur', 'shadowColor', 'shadowOffsetX', 'shadowOffsetY',
		])('%s has no getter and always reads back as undefined', (prop) => {
			const context = createContext()
			context[prop] = 'anything'

			expect(context[prop]).toBeUndefined()
		})

		it('keeps globalAlpha as the raw 0-1 value, not scaled to 0-255', () => {
			const context = createContext()
			context.setGlobalAlpha(0.5)

			expect(context.getActions()).toEqual([{ type: 'setGlobalAlpha', args: [0.5] }])
		})

		it('setShadow takes exactly the first four arguments', () => {
			const context = createContext()
			context.setShadow(1, 2, 3, '#fff', 'dropped')

			expect(context.getActions()).toEqual([{ type: 'setShadow', args: [1, 2, 3, '#fff'] }])
		})

		it.each([
			['setLineCap', 'round'],
			['setLineJoin', 'bevel'],
			['setLineWidth', 5],
			['setMiterLimit', 10],
			['setTextAlign', 'center'],
			['setTextBaseline', 'middle'],
			['setFillStyle', 'red'],
			['setStrokeStyle', 'blue'],
			['setGlobalAlpha', 0.5],
		])('%s only records the first argument, dropping the rest', (method, value) => {
			const context = createContext()
			context[method](value, 'extra', 'more-extra')

			expect(context.getActions()).toEqual([{ type: method, args: [value] }])
		})
	})

	describe('setLineDash normalization', () => {
		it('reports the default lineDash before any call', () => {
			const context = createContext()

			expect(context.getLineDash()).toEqual([0, 0])
		})

		it('defaults to [0, 0] when called with no arguments', () => {
			const context = createContext()
			context.setLineDash()

			expect(context.getActions()).toEqual([{ type: 'setLineDash', args: [[0, 0], 0] }])
			expect(context.getLineDash()).toEqual([0, 0])
		})

		it('normalizes an empty pattern to [0, 0] but keeps a given offset', () => {
			const context = createContext()
			context.setLineDash([], 5)

			expect(context.getActions()).toEqual([{ type: 'setLineDash', args: [[0, 0], 5] }])
		})

		it('defaults the offset to 0 when a pattern is given', () => {
			const context = createContext()
			context.setLineDash([5, 10])

			expect(context.getActions()).toEqual([{ type: 'setLineDash', args: [[5, 10], 0] }])
			expect(context.getLineDash()).toEqual([5, 10])
		})

		// 别名让录制时的守卫可以被绕过：守住的是「发出去的 payload 里不出现会被 JSON 折成 null 的值」，
		// 所以复查点必须在 getActions() 这个出口，而不是在录制那一刻。
		it('drops an action whose aliased array is mutated to a non-finite value after the guard ran', () => {
			const context = createContext()
			const pattern = [10, 10]
			context.setLineDash(pattern)
			context.setLineWidth(2)
			pattern[1] = Number.NaN

			expect(context.getActions()).toEqual([{ type: 'setLineWidth', args: [2] }])
		})

		// 官方存的是调用方那个数组本身，所以调用之后改它是会穿透的。
		it('keeps the caller-supplied array, so a later external mutation shows up in getLineDash', () => {
			const context = createContext()
			const pattern = [5, 5]
			context.setLineDash(pattern)
			pattern[0] = 100

			expect(context.getLineDash()).toEqual([100, 5])
		})

		// action 在 getActions() 取走时才快照，取走之前它读的还是同一个数组。
		it('records the same array, so a mutation before getActions shows up in the snapshot', () => {
			const context = createContext()
			const pattern = [5, 5]
			context.setLineDash(pattern)
			pattern[0] = 100

			expect(context.getActions()).toEqual([{ type: 'setLineDash', args: [[100, 5], 0] }])
		})
	})

})
