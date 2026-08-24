/** @vitest-environment jsdom */

// A compiled bare <canvas> remains a native tag, so c-event-node owns its
// touch/tap installation instead of a Vue component.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, provide, ref, resolveDirective, withCtx, withDirectives } from 'vue'
import { Components } from '../index.js'
import { useTouchEvents } from '../src/common/useTouchEvents.js'

let moduleCounter = 0
function nextModuleId() {
	moduleCounter += 1
	return `module-${moduleCounter}`
}

function touchPoint({ identifier = 0, pageX = 0, pageY = 0, clientX = pageX, clientY = pageY, screenX = pageX, screenY = pageY, force = 1 } = {}) {
	return { identifier, pageX, pageY, clientX, clientY, screenX, screenY, force }
}

function fire(target, type, props = {}) {
	const event = new Event(type, { bubbles: true, cancelable: true })
	Object.assign(event, props)
	target.dispatchEvent(event)
	return event
}

function fireTouch(el, type, { touches = [], changedTouches = touches } = {}) {
	return fire(el, type, { touches, changedTouches, targetTouches: touches })
}

// The listener types attachTouchEvents registers on the element itself, per
// canvas-bare-node-contract.md. `triggerEvent` short-circuits when there is no
// bind/catch handler for a given type, so observing `window.__message.send` alone
// cannot distinguish "no listener was ever registered" from "a listener fired and
// found nothing to call" -- the only way to see that distinction is to watch
// `addEventListener` itself.
const GESTURE_LISTENER_TYPES = ['touchstart', 'touchmove', 'touchend', 'touchcancel', 'pointerdown', 'click']

// Works with a spy on either addEventListener or removeEventListener -- both take
// (type, handler, ...) and are called with the element as `this`, so the same
// context-filtering logic reads off registrations or removals interchangeably.
function listenerTypesRegisteredOn(el, listenerSpy) {
	return listenerSpy.mock.calls
		.filter((_call, index) => listenerSpy.mock.contexts[index] === el)
		.map(([type]) => type)
}

function sentFor(moduleId) {
	return window.__message.send.mock.calls
		.filter(([msg]) => msg.body.moduleId === moduleId)
		.map(([msg]) => msg.body)
}

function typesFor(moduleId) {
	return sentFor(moduleId).map(body => body.event.type)
}

function flushGestureEvents() {
	return new Promise(resolve => queueMicrotask(resolve))
}

function mountApp(setup) {
	const container = document.createElement('div')
	document.body.append(container)
	const app = createApp({ setup })
	app.use(Components)
	app.mount(container)
	return { app, container }
}

// Mirrors how a compiled WXML page root provides context for `useInfo()`:
// bridgeId, the current page path, and the info object (carrying `id`) keyed by that path.
function providePageContext({ bridgeId, path, moduleId }) {
	if (bridgeId !== undefined)
		provide('bridgeId', bridgeId)
	if (path !== undefined)
		provide('path', path)
	if (path !== undefined && moduleId !== undefined)
		provide(path, { id: moduleId })
}

function canvasWithEventNode(props) {
	return withDirectives(h('canvas', props), [[resolveDirective('c-event-node'), 'node']])
}

const BRIDGE_ID = 'bridge-1'
const PATH = '/pages/index/index'

beforeEach(() => {
	window.__message = { send: vi.fn(), invoke: vi.fn(), on: vi.fn(), off: vi.fn() }
	window.__callback = { store: vi.fn(), remove: vi.fn() }
})

afterEach(() => {
	vi.useRealTimers()
	document.body.innerHTML = ''
})

describe('bare canvas elements only get gestures through the c-event-node directive', () => {
	it('synthesizes tap from a full touch sequence, resolving methodName/bridgeId/moduleId from context and stamping each touch point with coordinates relative to the canvas', async () => {
		const moduleId = nextModuleId()
		const { container } = mountApp(() => {
			providePageContext({ bridgeId: BRIDGE_ID, path: PATH, moduleId })
			return () => canvasWithEventNode({ 'canvas-id': 'c1', bindtap: 'onTap', bindtouchstart: 'onTouchStart' })
		})
		const canvasEl = container.querySelector('canvas')
		canvasEl.getBoundingClientRect = () => ({ left: 50, top: 30, right: 50, bottom: 30, width: 0, height: 0, x: 50, y: 30, toJSON() {} })

		fireTouch(canvasEl, 'touchstart', { touches: [touchPoint({ pageX: 130, pageY: 90, clientX: 120, clientY: 80 })] })
		fireTouch(canvasEl, 'touchend', { touches: [], changedTouches: [touchPoint({ pageX: 130, pageY: 90, clientX: 120, clientY: 80 })] })
		await flushGestureEvents()

		const sent = sentFor(moduleId)
		const touchStartCall = sent.find(body => body.event.type === 'touchstart')
		expect(touchStartCall).toBeDefined()
		expect(touchStartCall.methodName).toBe('onTouchStart')
		expect(touchStartCall.bridgeId).toBe(BRIDGE_ID)
		expect(touchStartCall.moduleId).toBe(moduleId)
		expect(touchStartCall.event.touches[0].x).toBe(70)
		expect(touchStartCall.event.touches[0].y).toBe(50)

		const tapCall = sent.find(body => body.event.type === 'tap')
		expect(tapCall).toBeDefined()
		expect(tapCall.methodName).toBe('onTap')
	})

	it('does not install a gesture on a non-canvas element carrying the same directive and attrs, while still recording the normal _ddEventBindings bookkeeping', () => {
		const moduleId = nextModuleId()
		const { container } = mountApp(() => {
			providePageContext({ bridgeId: BRIDGE_ID, path: PATH, moduleId })
			return () => withDirectives(h('div', { bindtap: 'onTap' }), [[resolveDirective('c-event-node'), 'node']])
		})
		const divEl = container.querySelector('div')

		fireTouch(divEl, 'touchstart', { touches: [touchPoint()] })
		fireTouch(divEl, 'touchend', { touches: [], changedTouches: [touchPoint()] })

		expect(window.__message.send).not.toHaveBeenCalled()
		expect(divEl._ddEventBindings).toHaveLength(1)
	})

	it('leaves the component in sole control of its <canvas> root gesture after it takes the element over from the outer c-event-node directive', async () => {
		const componentModuleId = nextModuleId()
		const outerModuleId = nextModuleId()
		const CanvasRootComponent = {
			props: ['canvasId'],
			setup(props) {
				const rootRef = ref(null)
				// A component that manages its own canvas gesture directly (the way
				// Canvas.vue does), independently of the page's provide/inject chain.
				// The bound handler name is deliberately different from the outer
				// directive's own attrs below, so a dispatched tap unambiguously tells
				// us which installation (component vs. directive) is still live.
				const info = { attrs: { bindtap: 'onComponentTap' }, bridgeId: BRIDGE_ID, moduleId: componentModuleId, path: PATH }
				useTouchEvents(info, rootRef, { relativeTo: rootRef })
				return () => h('canvas', { ref: rootRef, 'canvas-id': props.canvasId, bindtap: 'onOuterTap' })
			},
		}
		const addEventListenerSpy = vi.spyOn(EventTarget.prototype, 'addEventListener')
		const removeEventListenerSpy = vi.spyOn(EventTarget.prototype, 'removeEventListener')
		try {
			const { container } = mountApp(() => {
				providePageContext({ bridgeId: BRIDGE_ID, path: PATH, moduleId: outerModuleId })
				return () => withDirectives(h(CanvasRootComponent, { canvasId: 'c1' }), [[resolveDirective('c-event-node'), 'node']])
			})
			const canvasEl = container.querySelector('canvas')
			expect(canvasEl).toBeTruthy()

			// Net listener count: a takeover necessarily attaches, detaches, then
			// re-attaches, so the raw addEventListener call count is not the right
			// observable -- what must hold is that exactly one touchstart listener
			// is left live once mounting settles.
			const added = listenerTypesRegisteredOn(canvasEl, addEventListenerSpy).filter(type => type === 'touchstart').length
			const removed = listenerTypesRegisteredOn(canvasEl, removeEventListenerSpy).filter(type => type === 'touchstart').length
			expect(added - removed).toBe(1)

			fireTouch(canvasEl, 'touchstart', { touches: [touchPoint()] })
			fireTouch(canvasEl, 'touchend', { touches: [], changedTouches: [touchPoint()] })
		await flushGestureEvents()

			// User-observable outcome: exactly one tap is dispatched for this touch
			// sequence, and it belongs to the component's own module/handler, not
			// the outer directive's.
			const allTaps = window.__message.send.mock.calls
				.map(([msg]) => msg.body)
				.filter(body => body.event.type === 'tap')
			expect(allTaps).toHaveLength(1)
			expect(allTaps[0].moduleId).toBe(componentModuleId)
			expect(allTaps[0].methodName).toBe('onComponentTap')
		}
		finally {
			addEventListenerSpy.mockRestore()
			removeEventListenerSpy.mockRestore()
		}
	})

	it('installs and removes a bare canvas owner when event bindings change at runtime', async () => {
		const moduleId = nextModuleId()
		const enabled = ref(false)
		const { container } = mountApp(() => {
			providePageContext({ bridgeId: BRIDGE_ID, path: PATH, moduleId })
			return () => canvasWithEventNode({ 'canvas-id': 'dynamic', ...(enabled.value ? { bindtap: 'onTap' } : {}) })
		})
		const canvasEl = container.querySelector('canvas')

		fireTouch(canvasEl, 'touchstart', { touches: [touchPoint()] })
		fireTouch(canvasEl, 'touchend', { touches: [], changedTouches: [touchPoint()] })
		await flushGestureEvents()
		expect(sentFor(moduleId)).toEqual([])

		enabled.value = true
		await nextTick()
		fireTouch(canvasEl, 'touchstart', { touches: [touchPoint()] })
		fireTouch(canvasEl, 'touchend', { touches: [], changedTouches: [touchPoint()] })
		await flushGestureEvents()
		expect(typesFor(moduleId)).toContain('tap')

		window.__message.send.mockClear()
		enabled.value = false
		await nextTick()
		fireTouch(canvasEl, 'touchstart', { touches: [touchPoint()] })
		fireTouch(canvasEl, 'touchend', { touches: [], changedTouches: [touchPoint()] })
		await flushGestureEvents()
		expect(sentFor(moduleId)).toEqual([])
	})

	it('installs the gesture and dispatches tap for a canvas rendered inside a child component\'s default slot, mirroring the real <view><canvas/></view> structure', async () => {
		const moduleId = nextModuleId()
		const SlotHost = {
			render() {
				return h('div', { class: 'slot-host' }, this.$slots.default ? this.$slots.default() : [])
			},
		}
		const { container } = mountApp(() => {
			providePageContext({ bridgeId: BRIDGE_ID, path: PATH, moduleId })
			return () => h(SlotHost, {}, {
				default: withCtx(() => [canvasWithEventNode({ 'canvas-id': 'c1', bindtap: 'onTap' })]),
			})
		})
		const canvasEl = container.querySelector('canvas')
		expect(canvasEl).toBeTruthy()

		fireTouch(canvasEl, 'touchstart', { touches: [touchPoint()] })
		fireTouch(canvasEl, 'touchend', { touches: [], changedTouches: [touchPoint()] })
		await flushGestureEvents()

		const tapCall = sentFor(moduleId).find(body => body.event.type === 'tap')
		expect(tapCall).toBeDefined()
		expect(tapCall.methodName).toBe('onTap')
	})
})

describe('installing a bare canvas gesture requires a fully resolved context', () => {
	it('does not install a gesture and does not throw when bridgeId is missing from provides', () => {
		const moduleId = nextModuleId()
		let container
		expect(() => {
			({ container } = mountApp(() => {
				providePageContext({ path: PATH, moduleId })
				return () => canvasWithEventNode({ bindtap: 'onTap' })
			}))
		}).not.toThrow()

		const canvasEl = container.querySelector('canvas')
		expect(canvasEl).toBeTruthy()
		fireTouch(canvasEl, 'touchstart', { touches: [touchPoint()] })
		fireTouch(canvasEl, 'touchend', { touches: [], changedTouches: [touchPoint()] })
		expect(window.__message.send).not.toHaveBeenCalled()
	})

	it('does not install a gesture and does not throw when the page path is missing from provides', () => {
		let container
		expect(() => {
			({ container } = mountApp(() => {
				providePageContext({ bridgeId: BRIDGE_ID })
				return () => canvasWithEventNode({ bindtap: 'onTap' })
			}))
		}).not.toThrow()

		const canvasEl = container.querySelector('canvas')
		expect(canvasEl).toBeTruthy()
		fireTouch(canvasEl, 'touchstart', { touches: [touchPoint()] })
		fireTouch(canvasEl, 'touchend', { touches: [], changedTouches: [touchPoint()] })
		expect(window.__message.send).not.toHaveBeenCalled()
	})

	it('does not install a gesture and does not throw when the path is provided but its info object is missing', () => {
		let container
		expect(() => {
			({ container } = mountApp(() => {
				provide('bridgeId', BRIDGE_ID)
				provide('path', PATH)
				// Deliberately no `provide(PATH, { id: ... })`.
				return () => canvasWithEventNode({ bindtap: 'onTap' })
			}))
		}).not.toThrow()

		const canvasEl = container.querySelector('canvas')
		expect(canvasEl).toBeTruthy()
		fireTouch(canvasEl, 'touchstart', { touches: [touchPoint()] })
		fireTouch(canvasEl, 'touchend', { touches: [], changedTouches: [touchPoint()] })
		expect(window.__message.send).not.toHaveBeenCalled()
	})
})

describe('bare canvas gesture ownership follows its bindings', () => {
	it('registers the complete listener set when a Canvas has an interaction binding', () => {
		const moduleId = nextModuleId()
		const addEventListenerSpy = vi.spyOn(EventTarget.prototype, 'addEventListener')
		try {
			const { container } = mountApp(() => {
				providePageContext({ bridgeId: BRIDGE_ID, path: PATH, moduleId })
				return () => canvasWithEventNode({ 'canvas-id': 'c1', bindtap: 'onTap' })
			})
			const registeredTypes = listenerTypesRegisteredOn(container.querySelector('canvas'), addEventListenerSpy)
			for (const type of GESTURE_LISTENER_TYPES) expect(registeredTypes).toContain(type)
		}
		finally {
			addEventListenerSpy.mockRestore()
		}
	})

	it('does not install listeners without bind*/catch* interaction attrs', () => {
		const moduleId = nextModuleId()
		const addEventListenerSpy = vi.spyOn(EventTarget.prototype, 'addEventListener')
		try {
			const { container } = mountApp(() => {
				providePageContext({ bridgeId: BRIDGE_ID, path: PATH, moduleId })
				return () => canvasWithEventNode({ 'canvas-id': 'c1' })
			})
			const registeredTypes = listenerTypesRegisteredOn(container.querySelector('canvas'), addEventListenerSpy)
			for (const type of GESTURE_LISTENER_TYPES) expect(registeredTypes).not.toContain(type)
		}
		finally {
			addEventListenerSpy.mockRestore()
		}
	})

	it('lets an ancestor receive touch and tap from an unbound Canvas', async () => {
		const pageModuleId = nextModuleId()
		const ancestorInfo = { attrs: { bindtouchstart: 'onStart', bindtap: 'onTap' }, bridgeId: BRIDGE_ID, moduleId: nextModuleId() }
		const { container } = mountApp(() => {
			providePageContext({ bridgeId: BRIDGE_ID, path: PATH, moduleId: pageModuleId })
			const ancestorRef = ref(null)
			useTouchEvents(ancestorInfo, ancestorRef)
			return () => h('div', { ref: ancestorRef }, [canvasWithEventNode({ 'canvas-id': 'c1' })])
		})
		const canvasEl = container.querySelector('canvas')
		fireTouch(canvasEl, 'touchstart', { touches: [touchPoint()] })
		fireTouch(canvasEl, 'touchend', { touches: [], changedTouches: [touchPoint()] })
		await flushGestureEvents()
		expect(typesFor(ancestorInfo.moduleId)).toEqual(['touchstart', 'tap'])
	})
})

describe('the resolved handler follows attribute updates', () => {
	it('dispatches to the new bindtap handler after vnode.props changes, not the stale one', async () => {
		const moduleId = nextModuleId()
		const handlerName = ref('onA')
		const { container } = mountApp(() => {
			providePageContext({ bridgeId: BRIDGE_ID, path: PATH, moduleId })
			return () => canvasWithEventNode({ 'canvas-id': 'c1', bindtap: handlerName.value })
		})
		const canvasEl = container.querySelector('canvas')

		fireTouch(canvasEl, 'touchstart', { touches: [touchPoint()] })
		fireTouch(canvasEl, 'touchend', { touches: [], changedTouches: [touchPoint()] })
		await flushGestureEvents()
		let taps = sentFor(moduleId).filter(body => body.event.type === 'tap')
		expect(taps).toHaveLength(1)
		expect(taps[0].methodName).toBe('onA')

		handlerName.value = 'onB'
		await nextTick()

		fireTouch(canvasEl, 'touchstart', { touches: [touchPoint()] })
		fireTouch(canvasEl, 'touchend', { touches: [], changedTouches: [touchPoint()] })
		await flushGestureEvents()
		taps = sentFor(moduleId).filter(body => body.event.type === 'tap')
		expect(taps).toHaveLength(2)
		expect(taps[1].methodName).toBe('onB')
	})
})

describe('unmounting a directive-bound canvas', () => {
	it('keeps an active sequence until its real terminal event, then rejects new starts', async () => {
		vi.useFakeTimers()
		const moduleId = nextModuleId()
		const show = ref(true)
		const { container } = mountApp(() => {
			providePageContext({ bridgeId: BRIDGE_ID, path: PATH, moduleId })
			return () => (show.value
				? h('div', [canvasWithEventNode({ 'canvas-id': 'c1', bindlongpress: 'onLongPress', bindtouchend: 'onEnd', bindtap: 'onTap' })])
				: h('div'))
		})
		const canvasEl = container.querySelector('canvas')

		fireTouch(canvasEl, 'touchstart', { touches: [touchPoint()] })
		vi.advanceTimersByTime(350)
		show.value = false
		await nextTick()
		fireTouch(canvasEl, 'touchend', { touches: [], changedTouches: [touchPoint()] })
		await flushGestureEvents()
		expect(typesFor(moduleId)).toEqual(['longpress', 'touchend'])

		fireTouch(canvasEl, 'touchstart', { touches: [touchPoint()] })
		fireTouch(canvasEl, 'touchend', { touches: [], changedTouches: [touchPoint()] })
		await flushGestureEvents()
		expect(typesFor(moduleId)).toEqual(['longpress', 'touchend'])
	})
})

describe('a directive-installed bare canvas uses normal event propagation', () => {
	function mountAncestorWithCanvas({ ancestorAttrs, canvasAttrs }) {
		const canvasModuleId = nextModuleId()
		const ancestorInfo = { attrs: ancestorAttrs, bridgeId: BRIDGE_ID, moduleId: nextModuleId(), path: PATH }
		const { container } = mountApp(() => {
			providePageContext({ bridgeId: BRIDGE_ID, path: PATH, moduleId: canvasModuleId })
			const ancestorRef = ref(null)
			useTouchEvents(ancestorInfo, ancestorRef)
			return () => h('div', { ref: ancestorRef }, [canvasWithEventNode(canvasAttrs)])
		})
		return { ancestorInfo, canvasEl: container.querySelector('canvas'), canvasModuleId }
	}

	it('a touchstart reaches Canvas then ancestor with currentTarget on both payloads', () => {
		const { ancestorInfo, canvasEl, canvasModuleId } = mountAncestorWithCanvas({
			ancestorAttrs: { bindtouchstart: 'onAncestorTouchStart' },
			canvasAttrs: { 'canvas-id': 'c1', bindtouchstart: 'onCanvasTouchStart' },
		})

		fireTouch(canvasEl, 'touchstart', { touches: [touchPoint()] })

		expect(typesFor(ancestorInfo.moduleId)).toContain('touchstart')
		const canvasTouchStart = sentFor(canvasModuleId).find(body => body.event.type === 'touchstart')
		const ancestorTouchStart = sentFor(ancestorInfo.moduleId).find(body => body.event.type === 'touchstart')
		expect(canvasTouchStart.event).toHaveProperty('currentTarget')
		expect(ancestorTouchStart.event).toHaveProperty('currentTarget')
	})

	it('the synthesized tap bubbles from Canvas to ancestor with currentTarget on both payloads', async () => {
		const { ancestorInfo, canvasEl, canvasModuleId } = mountAncestorWithCanvas({
			ancestorAttrs: { bindtap: 'onAncestorTap' },
			canvasAttrs: { 'canvas-id': 'c1', bindtap: 'onCanvasTap' },
		})

		fireTouch(canvasEl, 'touchstart', { touches: [touchPoint()] })
		fireTouch(canvasEl, 'touchend', { touches: [], changedTouches: [touchPoint()] })
		await flushGestureEvents()

		expect(typesFor(ancestorInfo.moduleId)).toContain('tap')
		const canvasTap = sentFor(canvasModuleId).find(body => body.event.type === 'tap')
		expect(canvasTap).toBeDefined()
		expect(Object.prototype.hasOwnProperty.call(canvasTap.event, 'currentTarget')).toBe(true)
	})
})

describe('bare canvas disable-scroll', () => {
	it('prevents the native touchmove default without requiring catchtouchmove', () => {
		const moduleId = nextModuleId()
		const { container } = mountApp(() => {
			providePageContext({ bridgeId: BRIDGE_ID, path: PATH, moduleId })
			return () => canvasWithEventNode({
				'canvas-id': 'scroll-blocking',
				'disable-scroll': true,
				bindtouchmove: 'onMove',
			})
		})
		const canvasEl = container.querySelector('canvas')
		fireTouch(canvasEl, 'touchstart', { touches: [touchPoint({ pageX: 10, pageY: 10 })] })
		const move = fireTouch(canvasEl, 'touchmove', { touches: [touchPoint({ pageX: 30, pageY: 10 })] })

		expect(move.defaultPrevented).toBe(true)
	})
})
