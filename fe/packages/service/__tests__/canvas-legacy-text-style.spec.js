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

	describe('font setter parsing', () => {
		it('defaults to 10px sans-serif before any assignment', () => {
			const context = createContext()

			expect(context.font).toBe('10px sans-serif')
		})

		it('emits a single setFont action, not one action per component', () => {
			const context = createContext()
			context.font = 'italic bold 20px Arial'

			expect(context.getActions()).toEqual([
				{ type: 'setFont', args: ['italic bold 20px Arial'] },
			])
		})

		it('reassembles a lone weight modifier with a padded "normal" style, not the raw input string', () => {
			const context = createContext()
			context.font = 'bold 16px serif'

			expect(context.getActions()).toEqual([
				{ type: 'setFont', args: ['bold normal 16px serif'] },
			])
		})

		it('reassembles "normal normal" when the font string has no style/weight prefix at all', () => {
			const context = createContext()
			context.font = '20px Arial'

			expect(context.getActions()).toEqual([
				{ type: 'setFont', args: ['normal normal 20px Arial'] },
			])
		})

		it('treats a single "normal" modifier as fontStyle (checked first) and pads fontWeight to "normal" too', () => {
			const context = createContext()
			context.font = 'normal 14px "PingFang SC"'

			expect(context.getActions()).toEqual([
				{ type: 'setFont', args: ['normal normal 14px "PingFang SC"'] },
			])
		})

		it('keeps the modifiers in their original traversal order instead of reordering to style-then-weight', () => {
			const context = createContext()
			context.font = 'bold italic 18px Georgia'

			expect(context.getActions()).toEqual([
				{ type: 'setFont', args: ['bold italic 18px Georgia'] },
			])
		})

		it('falls back to a "normal" weight for an unrecognized second modifier token', () => {
			const context = createContext()
			context.font = 'italic condensed 16px Arial'

			expect(context.getActions()).toEqual([
				{ type: 'setFont', args: ['italic normal 16px Arial'] },
			])
		})

		it('rejects a non-px unit such as pt, warning instead of emitting an action', () => {
			const context = createContext()
			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
			context.font = '12pt Arial'

			expect(context.getActions()).toEqual([])
			expect(warnSpy).toHaveBeenCalledWith('Failed to set \'font\' on \'CanvasContext\': invalid format.')
			expect(context.font).toBe('12pt Arial')
		})

		it('warns but still reads back an unparsable font string, while the render side keeps the last valid one', () => {
			// 基础库的 setter 先存原始串再解析，失败只跳过动作，所以 getter 回读的是非法串本身。
			const context = createContext()
			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
			context.font = 'bold 16px serif'
			context.font = 'not-a-font'

			expect(context.getActions()).toEqual([{ type: 'setFont', args: ['bold normal 16px serif'] }])
			expect(warnSpy).toHaveBeenCalledWith('Failed to set \'font\' on \'CanvasContext\': invalid format.')
			expect(context.font).toBe('not-a-font')
		})

		it('keeps the getter on the raw input string even though the recorded action carries the reassembled one', () => {
			const context = createContext()
			context.font = 'bold 16px serif'

			expect(context.getActions()).toEqual([{ type: 'setFont', args: ['bold normal 16px serif'] }])
			expect(context.font).toBe('bold 16px serif')
		})
	})

	describe('setFontSize', () => {
		it('records a setFontSize action', () => {
			const context = createContext()
			context.setFontSize(24)

			expect(context.getActions()).toEqual([{ type: 'setFontSize', args: [24] }])
		})

		it('rewrites the px number embedded in the font string', () => {
			const context = createContext()
			context.font = 'italic bold 16px Arial'
			context.clearActions()
			context.setFontSize(24)

			expect(context.font).toBe('italic bold 24px Arial')
		})
	})

	describe('setFontSize input validation', () => {
		// A naive string replace on state.font (e.g. replacing the "16" in "16px" with the
		// raw argument) corrupts state.font into something like "20pxpx sans-serif" for any
		// non-finite-number input. Real canvas silently rejects that malformed font string and
		// keeps rendering with whatever font it had before, so from then on every measureText
		// and every draw() is silently stuck on the wrong font — and it's sticky: a later valid
		// setFontSize regex-replaces only the leading digits, so "20pxpx" becomes "30pxpx",
		// still malformed.

		it.each([
			['a non-numeric string', '20px'],
			['undefined', undefined],
			['NaN', Number.NaN],
			['Infinity', Number.POSITIVE_INFINITY],
		])('does not touch state.font or emit an action for %s', (_label, value) => {
			const context = createContext()
			const before = context.font
			context.setFontSize(value)

			expect(context.font).toBe(before)
			expect(context.getActions()).toEqual([])
		})

		it('does not permanently corrupt state.font, so a later valid setFontSize still parses cleanly', () => {
			const context = createContext()
			context.setFontSize('20px')
			context.setFontSize(30)

			expect(context.font).toBe('30px sans-serif')
			expect(context.getActions()).toEqual([{ type: 'setFontSize', args: [30] }])
		})
	})

	describe('save / restore', () => {
		it('records save and restore actions', () => {
			const context = createContext()
			context.save()
			context.restore()

			expect(context.getActions()).toEqual([
				{ type: 'save', args: [] },
				{ type: 'restore', args: [] },
			])
		})

		// 微信入栈的是 state 本身，setter 又在原地改它，所以 restore 弹回来的是同一个对象，
		// 逻辑层状态不回滚。只有渲染层那份 2D 上下文状态会被 save / restore 动作真正回滚。
		it('does not roll back font or fontSize on restore', () => {
			const context = createContext()
			context.save()
			context.setFontSize(24)
			context.restore()

			expect(context.font).toBe('24px sans-serif')
		})

		it('does not roll back lineDash on restore', () => {
			const context = createContext()
			context.setLineDash([1, 2])
			context.save()
			context.setLineDash([5, 6], 3)
			context.restore()

			expect(context.getLineDash()).toEqual([5, 6])
		})

		it('resets to the documented initial state when restore is called with an empty stack', () => {
			const context = createContext()
			context.setLineDash([9, 9], 5)
			context.setFontSize(30)
			context.restore()

			expect(context.getLineDash()).toEqual([0, 0])
			expect(context.font).toBe('10px sans-serif')
		})
	})

	describe('gradients and patterns', () => {
		it('serializes a linear gradient assigned to fillStyle', () => {
			const context = createContext()
			const gradient = context.createLinearGradient(0, 0, 100, 0)
			gradient.addColorStop(0, '#fff')
			gradient.addColorStop(1, '#000')
			context.fillStyle = gradient

			expect(context.getActions()).toEqual([{
				type: 'setFillStyle',
				args: [{
					__canvasStyle: 'gradient',
					type: 'linear',
					data: [0, 0, 100, 0],
					colorStop: [[0, '#fff'], [1, '#000']],
				}],
			}])
		})

		it('serializes a radial gradient from createCircularGradient', () => {
			const context = createContext()
			const gradient = context.createCircularGradient(50, 50, 25)
			gradient.addColorStop(0.5, 'red')
			context.strokeStyle = gradient

			expect(context.getActions()).toEqual([{
				type: 'setStrokeStyle',
				args: [{
					__canvasStyle: 'gradient',
					type: 'radial',
					data: [50, 50, 25],
					colorStop: [[0.5, 'red']],
				}],
			}])
		})

		it('serializes a pattern assigned to fillStyle', () => {
			const context = createContext()
			const pattern = context.createPattern('tile.png', 'repeat')
			context.fillStyle = pattern

			expect(context.getActions()).toEqual([{
				type: 'setFillStyle',
				args: [{ __canvasStyle: 'pattern', image: 'tile.png', repetition: 'repeat' }],
			}])
		})

		it('errors and returns undefined when createPattern is called with only one argument', () => {
			const context = createContext()
			const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
			const result = context.createPattern('tile.png')

			expect(result).toBeUndefined()
			expect(errorSpy).toHaveBeenCalledWith(
				'Failed to execute \'createPattern\' on \'CanvasContext\': 2 arguments required, but only 1 present.',
			)
		})

		it('errors and returns undefined for an unsupported repetition value', () => {
			const context = createContext()
			const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
			const result = context.createPattern('tile.png', 'diagonal')

			expect(result).toBeUndefined()
			expect(errorSpy).toHaveBeenCalledWith(
				'Failed to execute \'createPattern\' on \'CanvasContext\': The provided type (\'diagonal\') is not one of \'repeat\', \'no-repeat\', \'repeat-x\', or \'repeat-y\'.',
			)
		})
	})

	describe('measureText', () => {
		it('returns synchronously with a numeric width when there is no OffscreenCanvas or document', () => {
			const context = createContext()
			const result = context.measureText('hello')

			expect(result).toBeTruthy()
			expect(typeof result.width).toBe('number')
		})

		it('does not throw when measuring in a node environment without a real canvas', () => {
			const context = createContext()

			expect(() => context.measureText('hello world')).not.toThrow()
		})

		it('uses a real OffscreenCanvas 2d context when available, applying the current font before measuring', () => {
			let capturedFont
			class FakeOffscreenContext2D {
				set font(value) {
					capturedFont = value
				}

				get font() {
					return capturedFont
				}

				measureText(text) {
					return { width: text.length * 2 }
				}
			}
			class FakeOffscreenCanvas {
				getContext() {
					return new FakeOffscreenContext2D()
				}
			}

			const original = globalThis.OffscreenCanvas
			globalThis.OffscreenCanvas = FakeOffscreenCanvas
			try {
				const context = createContext()
				const result = context.measureText('ab')

				expect(capturedFont).toBe('10px sans-serif')
				expect(result.width).toBe(4)
			}
			finally {
				globalThis.OffscreenCanvas = original
			}
		})

		it('measures using the raw font string, not the reassembled setFont action string', () => {
			let capturedFont
			class FakeOffscreenContext2D {
				set font(value) {
					capturedFont = value
				}

				get font() {
					return capturedFont
				}

				measureText() {
					return { width: 1 }
				}
			}
			class FakeOffscreenCanvas {
				getContext() {
					return new FakeOffscreenContext2D()
				}
			}

			const original = globalThis.OffscreenCanvas
			globalThis.OffscreenCanvas = FakeOffscreenCanvas
			try {
				const context = createContext()
				context.font = 'bold 16px serif'
				context.measureText('x')

				expect(capturedFont).toBe('bold 16px serif')
			}
			finally {
				globalThis.OffscreenCanvas = original
			}
		})

		it('does not add any action', () => {
			const context = createContext()
			context.beginPath()
			context.measureText('x')

			expect(context.getActions()).toEqual([])
		})
	})

	describe('measureText text coercion matches fillText\'s String(text) semantics', () => {
		// fillText/strokeText coerce their text argument with String(text), so String(null)
		// draws the literal word "null" and String(undefined) draws "undefined" — matching real
		// canvas. measureText must use the same coercion; otherwise the same value measures as
		// an empty string in one call and draws as a 4-letter word in the other, and any layout
		// code that centers or wraps text using measureText's result ends up misaligned with
		// what actually gets drawn.

		it('measures null the same as the literal string "null", not as an empty string', () => {
			const context = createContext()
			const nullResult = context.measureText(null)
			const literalResult = context.measureText('null')

			expect(nullResult.width).toBe(literalResult.width)
			expect(nullResult.width).toBeGreaterThan(0)
		})

		it('measures undefined the same as the literal string "undefined"', () => {
			const context = createContext()
			const undefinedResult = context.measureText(undefined)
			const literalResult = context.measureText('undefined')

			expect(undefinedResult.width).toBe(literalResult.width)
			expect(undefinedResult.width).toBeGreaterThan(0)
		})
	})

	describe('measureText fallback estimation (no OffscreenCanvas, no document)', () => {
		// This node test environment has neither OffscreenCanvas nor document, so every
		// measureText call here necessarily takes the size-based fallback estimate. A native
		// mini-program host is in the same position (no browser canvas primitives in the
		// service thread), so this fallback is not a rare corner case there.

		it('estimates a pure CJK string at roughly one font-size unit per character', () => {
			const context = createContext()
			context.setFontSize(20)
			const result = context.measureText('中文测试内容')

			const perCharWidth = result.width / 6
			expect(perCharWidth).toBeGreaterThan(20 * 0.8)
			expect(perCharWidth).toBeLessThan(20 * 1.2)
		})

		it('estimates a pure ASCII string at roughly half a font-size unit per character', () => {
			const context = createContext()
			context.setFontSize(20)
			const result = context.measureText('abcdefgh')

			const perCharWidth = result.width / 8
			expect(perCharWidth).toBeGreaterThan(20 * 0.5 * 0.7)
			expect(perCharWidth).toBeLessThan(20 * 0.5 * 1.3)
		})

		it('estimates same-length CJK text as substantially wider than ASCII text, not the same width', () => {
			const context = createContext()
			context.setFontSize(20)
			const ascii = context.measureText('aaaaaaaaaa')
			const cjk = context.measureText('中中中中中中中中中中')

			expect(cjk.width).toBeGreaterThan(ascii.width * 1.5)
		})

		it('estimates mixed CJK/ASCII text between the pure-CJK and pure-ASCII per-character rates', () => {
			const context = createContext()
			context.setFontSize(20)
			const asciiOnly = context.measureText('aaaa')
			const cjkOnly = context.measureText('中文中文')
			const mixed = context.measureText('a中a中')

			expect(mixed.width).toBeGreaterThan(asciiOnly.width)
			expect(mixed.width).toBeLessThan(cjkOnly.width)
		})

		it('weighs full-width punctuation like CJK characters, not like ASCII', () => {
			const context = createContext()
			context.setFontSize(20)
			const ascii = context.measureText('aaaa')
			const fullWidthPunctuation = context.measureText('，。！？')

			expect(fullWidthPunctuation.width).toBeGreaterThan(ascii.width * 1.5)
		})
	})

})
