import { afterEach, beforeEach, vi } from 'vitest'
import { JSDOM } from 'jsdom'

// A real CanvasRenderingContext2D silently ignores an assignment of an
// illegal enum value for these properties and keeps whatever was set
// before it — it does not throw and does not fall back to a spec default.
// Mirroring that on the recording double lets tests catch a render layer
// that forwards a WeChat-only-legal (but not real-canvas-legal) string
// straight through — e.g. textBaseline: 'normal' — without special-casing
// every such literal one at a time in the double itself.
const CANVAS_ENUM_VALUES = {
	lineCap: new Set(['butt', 'round', 'square']),
	lineJoin: new Set(['round', 'bevel', 'miter']),
	textAlign: new Set(['start', 'end', 'left', 'right', 'center']),
	textBaseline: new Set(['top', 'hanging', 'middle', 'alphabetic', 'ideographic', 'bottom']),
	globalCompositeOperation: new Set([
		'source-over',
		'source-in',
		'source-out',
		'source-atop',
		'destination-over',
		'destination-in',
		'destination-out',
		'destination-atop',
		'lighter',
		'copy',
		'xor',
		'multiply',
		'screen',
		'overlay',
		'darken',
		'lighten',
		'color-dodge',
		'color-burn',
		'hard-light',
		'soft-light',
		'difference',
		'exclusion',
		'hue',
		'saturation',
		'color',
		'luminosity',
	]),
}

/**
 * A recording double for CanvasRenderingContext2D.
 *
 * Every tracked method is a vi.fn() that also appends an entry to a shared
 * `record` array, and every tracked property is backed by a getter/setter
 * pair that does the same. `record` therefore reflects the exact temporal
 * order in which the replay touched the context, which is what several
 * tests below (setShadow's field order, draw-batch serialization) depend on.
 *
 * `save` / `restore` maintain a real push/pop stack over the tracked
 * property values, mirroring what a genuine CanvasRenderingContext2D does.
 * This lets the font tests prove the render layer reads `ctx.font` itself
 * after a restore instead of keeping a shadow copy that can drift from it.
 */
export function createRecordingContext() {
	const record = []
	const ctx = {}

	const passthroughMethods = [
		'beginPath',
		'closePath',
		'moveTo',
		'lineTo',
		'rect',
		'arc',
		'arcTo',
		'quadraticCurveTo',
		'bezierCurveTo',
		'fill',
		'stroke',
		'clip',
		'clearRect',
		'fillRect',
		'strokeRect',
		'translate',
		'rotate',
		'scale',
		'transform',
		'setTransform',
		'fillText',
		'strokeText',
		'drawImage',
	]
	for (const name of passthroughMethods) {
		ctx[name] = vi.fn((...args) => {
			record.push({ kind: 'call', name, args })
		})
	}

	const trackedProperties = [
		'fillStyle',
		'strokeStyle',
		'globalAlpha',
		'lineCap',
		'lineJoin',
		'lineWidth',
		'miterLimit',
		'textAlign',
		'textBaseline',
		'globalCompositeOperation',
		'lineDashOffset',
		'shadowBlur',
		'shadowColor',
		'shadowOffsetX',
		'shadowOffsetY',
		'font',
	]
	// Real CanvasRenderingContext2D instances start with these values, not
	// undefined. save()/restore() snapshot and restore the whole state, so a
	// context that starts "empty" understates what a real restore() actually
	// puts back — it would silently under-report leaks tests are meant to
	// catch (see the reserve:false cross-batch leak test).
	const defaultValues = {
		fillStyle: '#000000',
		strokeStyle: '#000000',
		globalAlpha: 1,
		lineCap: 'butt',
		lineJoin: 'miter',
		lineWidth: 1,
		miterLimit: 10,
		textAlign: 'start',
		textBaseline: 'alphabetic',
		globalCompositeOperation: 'source-over',
		lineDashOffset: 0,
		shadowBlur: 0,
		shadowColor: '#000000',
		shadowOffsetX: 0,
		shadowOffsetY: 0,
		font: '10px sans-serif',
	}
	const values = { ...defaultValues }
	for (const prop of trackedProperties) {
		Object.defineProperty(ctx, prop, {
			configurable: true,
			enumerable: true,
			get() {
				return values[prop]
			},
			set(value) {
				const allowedValues = CANVAS_ENUM_VALUES[prop]
				if (allowedValues && !allowedValues.has(value)) {
					// Silently rejected, exactly like a real context: no state
					// change, no recorded write.
					return
				}
				values[prop] = value
				record.push({ kind: 'set', name: prop, value })
			},
		})
	}

	let lineDash = []
	ctx.setLineDash = vi.fn((pattern) => {
		lineDash = [...pattern]
		record.push({ kind: 'call', name: 'setLineDash', args: [pattern] })
	})
	ctx.getLineDash = vi.fn(() => [...lineDash])

	const restoreStack = []
	ctx.save = vi.fn(() => {
		record.push({ kind: 'call', name: 'save', args: [] })
		restoreStack.push({ values: { ...values }, lineDash: [...lineDash] })
	})
	ctx.restore = vi.fn(() => {
		record.push({ kind: 'call', name: 'restore', args: [] })
		const previous = restoreStack.pop()
		if (previous) {
			Object.assign(values, previous.values)
			lineDash = previous.lineDash
		}
	})
	// Rebuilding the backing store is the observable difference between "kept the
	// pixels" and "wiped them", so tests that assert draw(true) preserves the
	// picture count these instead of guessing from the state values.
	ctx.__resizeResetCount = 0
	ctx.__resetForCanvasResize = () => {
		ctx.__resizeResetCount += 1
		Object.assign(values, defaultValues)
		lineDash = []
		restoreStack.length = 0
	}

	ctx.createLinearGradient = vi.fn((...args) => {
		record.push({ kind: 'call', name: 'createLinearGradient', args })
		return createGradientStub(record)
	})
	ctx.createRadialGradient = vi.fn((...args) => {
		record.push({ kind: 'call', name: 'createRadialGradient', args })
		return createGradientStub(record)
	})
	ctx.createPattern = vi.fn((...args) => {
		record.push({ kind: 'call', name: 'createPattern', args })
		return { __isPatternStub: true }
	})

	return { ctx, record, values, getStackDepth: () => restoreStack.length }
}

function createGradientStub(record) {
	const stub = { __isGradientStub: true }
	stub.addColorStop = vi.fn((stop, color) => {
		record.push({ kind: 'call', name: 'addColorStop', args: [stop, color], target: stub })
	})
	return stub
}

/** Resolves onload on the next microtask, like a same-origin image would. */
export class ResolvingImage {
	set src(value) {
		this._src = value
		Promise.resolve().then(() => this.onload?.())
	}

	get src() {
		return this._src
	}
}

/** Fires onerror on the next microtask, simulating a broken image URL. */
export class FailingImage {
	set src(value) {
		this._src = value
		Promise.resolve().then(() => this.onerror?.(new Error(`failed to load ${value}`)))
	}

	get src() {
		return this._src
	}
}


export let runtime

export function useCanvasRuntimeHarness() {
	let dom

	beforeEach(async () => {
		dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
		globalThis.window = dom.window
		globalThis.document = dom.window.document
		globalThis.Node = dom.window.Node
		globalThis.Element = dom.window.Element
		globalThis.HTMLElement = dom.window.HTMLElement
		globalThis.SVGElement = dom.window.SVGElement
		globalThis.MutationObserver = dom.window.MutationObserver
		globalThis.navigator = dom.window.navigator
		globalThis.Image = dom.window.Image
		globalThis.requestAnimationFrame = dom.window.requestAnimationFrame ?? (cb => setTimeout(cb, 0))
		globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame ?? (id => clearTimeout(id))

		const runtimeModule = await import('../src/core/runtime.js')
		runtime = runtimeModule.default
	})

	afterEach(() => {
		vi.restoreAllMocks()
		vi.useRealTimers()
		dom.window.close()
		delete globalThis.window
		delete globalThis.document
		delete globalThis.Node
		delete globalThis.Element
		delete globalThis.HTMLElement
		delete globalThis.SVGElement
		delete globalThis.MutationObserver
		delete globalThis.navigator
		delete globalThis.Image
		delete globalThis.requestAnimationFrame
		delete globalThis.cancelAnimationFrame
	})
}

export function mountCanvas(canvasId, ctx) {
	const canvas = document.createElement('canvas')
	canvas.setAttribute('canvas-id', canvasId)
	const widthDescriptor = Object.getOwnPropertyDescriptor(canvas.constructor.prototype, 'width')
	Object.defineProperty(canvas, 'width', {
		configurable: true,
		get: () => widthDescriptor.get.call(canvas),
		set: (value) => {
			widthDescriptor.set.call(canvas, value)
			ctx.__resetForCanvasResize?.()
		},
	})
	canvas.width = 200
	canvas.height = 100
	canvas.getContext = vi.fn(() => ctx)
	// jsdom reports a zero rectangle, while runtime resolution follows the rendered box.
	canvas.getBoundingClientRect = vi.fn(() => ({
		left: 0,
		top: 0,
		right: canvas.width,
		bottom: canvas.height,
		width: canvas.width,
		height: canvas.height,
	}))
	document.body.append(canvas)
	return canvas
}
