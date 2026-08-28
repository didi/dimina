/** @vitest-environment jsdom */
// Guards tap/longpress/longtap/canceltap synthesis from touch and pointer input,
// including normal Canvas bubbling and relative-coordinate semantics.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, ref } from 'vue'
import { useTouchEvents } from '../src/common/useTouchEvents.js'
let moduleCounter = 0
function makeInfo(attrs) {
	moduleCounter += 1
	return {
		attrs,
		bridgeId: 'bridge-1',
		moduleId: `module-${moduleCounter}`,
		path: '/pages/index/index',
	}
}
function touchPoint({ identifier = 0, pageX = 0, pageY = 0, clientX = pageX, clientY = pageY, screenX = pageX, screenY = pageY, force = 1 } = {}) {
	return { identifier, pageX, pageY, clientX, clientY, screenX, screenY, force }
}
// The 8 standard fields sendTriggerEvent maps every touch point to.
function std8(t) {
	return {
		clientX: t.clientX,
		clientY: t.clientY,
		force: t.force,
		identifier: t.identifier,
		pageX: t.pageX,
		pageY: t.pageY,
		screenX: t.screenX,
		screenY: t.screenY,
	}
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
function mountSingle(info, options) {
	const container = document.createElement('div')
	document.body.append(container)
	const Comp = {
		setup() {
			const elRef = ref(null)
			useTouchEvents(info, elRef, options)
			return () => h('div', { ref: elRef })
		},
	}
	const app = createApp(Comp)
	app.mount(container)
	return container.firstElementChild
}
function mountCanvasLike(info, options, canvasRect) {
	const container = document.createElement('div')
	document.body.append(container)
	const Comp = {
		setup() {
			const rootRef = ref(null)
			const canvasRef = ref(null)
			useTouchEvents(info, rootRef, { ...options, relativeTo: canvasRef })
			return () => h('div', { ref: rootRef }, [h('canvas', { ref: canvasRef })])
		},
	}
	const app = createApp(Comp)
	app.mount(container)
	const canvasEl = container.querySelector('canvas')
	canvasEl.getBoundingClientRect = () => ({
		left: canvasRect.left,
		top: canvasRect.top,
		right: canvasRect.left,
		bottom: canvasRect.top,
		width: 0,
		height: 0,
		x: canvasRect.left,
		y: canvasRect.top,
		toJSON() {},
	})
	return { rootEl: container.firstElementChild, canvasEl }
}
function mountNested({ ancestorInfo, ancestorOptions, descendantInfo, descendantOptions }) {
	const container = document.createElement('div')
	document.body.append(container)
	const Descendant = {
		setup() {
			const elRef = ref(null)
			useTouchEvents(descendantInfo, elRef, descendantOptions)
			return () => h('div', { ref: elRef, class: 'descendant' })
		},
	}
	const Ancestor = {
		setup() {
			const elRef = ref(null)
			useTouchEvents(ancestorInfo, elRef, ancestorOptions)
			return () => h('div', { ref: elRef, class: 'ancestor' }, [h(Descendant)])
		},
	}
	const app = createApp(Ancestor)
	app.mount(container)
	return {
		ancestorEl: container.querySelector('.ancestor'),
		descendantEl: container.querySelector('.descendant'),
	}
}
function sentFor(moduleId) {
	return window.__message.send.mock.calls
		.filter(([msg]) => msg.body.moduleId === moduleId)
		.map(([msg]) => msg.body)
}
function typesFor(moduleId) {
	return sentFor(moduleId).map(body => body.event.type)
}
function countType(moduleId, type) {
	return typesFor(moduleId).filter(t => t === type).length
}
function flushGestureEvents() {
	return new Promise(resolve => queueMicrotask(resolve))
}
beforeEach(() => {
	window.__message = { send: vi.fn(), invoke: vi.fn(), on: vi.fn(), off: vi.fn() }
	window.__callback = { store: vi.fn(), remove: vi.fn() }
})
afterEach(() => {
	vi.useRealTimers()
	document.body.innerHTML = ''
})
describe('tap is synthesized from the touch sequence', () => {
	it('synthesizes tap on touchend: detail.x/y come from touchend, touches/changedTouches come from touchstart', async () => {
		const info = makeInfo({ bindtap: 'onTap', bindtouchstart: 'onTouchStart' })
		const el = mountSingle(info, {})
		const start = touchPoint({ identifier: 7, pageX: 10, pageY: 20, clientX: 11, clientY: 21, screenX: 12, screenY: 22, force: 0.5 })
		fireTouch(el, 'touchstart', { touches: [start] })
		const lifted = touchPoint({ identifier: 7, pageX: 14, pageY: 24, clientX: 15, clientY: 25, screenX: 16, screenY: 26, force: 0.6 })
		fireTouch(el, 'touchend', { touches: [], changedTouches: [lifted] })
		await flushGestureEvents()
		const sent = sentFor(info.moduleId)
		const tapCall = sent.find(body => body.event.type === 'tap')
		expect(tapCall).toBeDefined()
		expect(tapCall.methodName).toBe('onTap')
		expect(tapCall.event.detail.x).toBe(14)
		expect(tapCall.event.detail.y).toBe(24)
		expect(tapCall.event.touches[0]).toEqual(std8(start))
		expect(tapCall.event.changedTouches[0]).toEqual(std8(start))
		const touchStartCall = sent.find(body => body.event.type === 'touchstart')
		expect(touchStartCall.event.touches[0]).toEqual(std8(start))
	})
	it('cancels the tap when the finger lifts far from where it landed, even though no touchmove ever arrived', async () => {
		const info = makeInfo({ bindtap: 'onTap', bindcanceltap: 'onCancelTap' })
		const el = mountSingle(info, {})
		const start = touchPoint({ identifier: 7, pageX: 10, pageY: 20, clientX: 11, clientY: 21 })
		fireTouch(el, 'touchstart', { touches: [start] })
		// A page that preventDefaults touchmove, or a system that folds the drag into
		// the lift, leaves touchend as the only place this displacement is observable.
		const lifted = touchPoint({ identifier: 7, pageX: 90, pageY: 20, clientX: 91, clientY: 21 })
		fireTouch(el, 'touchend', { touches: [], changedTouches: [lifted] })
		await flushGestureEvents()
		expect(countType(info.moduleId, 'canceltap')).toBe(1)
		expect(typesFor(info.moduleId)).not.toContain('tap')
	})
	it('a movement under moveThreshold still counts as a tap', async () => {
		const info = makeInfo({ bindtap: 'onTap' })
		const el = mountSingle(info, {})
		fireTouch(el, 'touchstart', { touches: [touchPoint({ pageX: 0, pageY: 0 })] })
		fireTouch(el, 'touchmove', { touches: [touchPoint({ pageX: 3, pageY: 0 })] })
		fireTouch(el, 'touchend', { touches: [], changedTouches: [touchPoint({ pageX: 3, pageY: 0 })] })
		await flushGestureEvents()
		expect(typesFor(info.moduleId)).toContain('tap')
	})
	it('does not synthesize tap once movement exceeds moveThreshold', async () => {
		const info = makeInfo({ bindtap: 'onTap', bindtouchend: 'onTouchEnd' })
		const el = mountSingle(info, {})
		fireTouch(el, 'touchstart', { touches: [touchPoint({ pageX: 0, pageY: 0 })] })
		fireTouch(el, 'touchmove', { touches: [touchPoint({ pageX: 40, pageY: 0 })] })
		fireTouch(el, 'touchend', { touches: [], changedTouches: [touchPoint({ pageX: 40, pageY: 0 })] })
		await flushGestureEvents()
		const types = typesFor(info.moduleId)
		expect(types).toContain('touchend')
		expect(types).not.toContain('tap')
	})
})
describe('canceltap', () => {
	// 位移取消后每一条 touchmove 都带一条 canceltap：同一个探针小程序在微信开发者工具上跑，
	// 两次越过阈值的移动记到两条 canceltap。抬手时起点终点已经远离，也不再补发第三条。
	it('dispatches a canceltap for every move that crosses the threshold', async () => {
		const info = makeInfo({ bindtap: 'onTap', bindcanceltap: 'onCancelTap', bindtouchmove: 'onTouchMove' })
		const el = mountSingle(info, {})
		fireTouch(el, 'touchstart', { touches: [touchPoint({ pageX: 0, pageY: 0 })] })
		fireTouch(el, 'touchmove', { touches: [touchPoint({ pageX: 30, pageY: 0 })] })
		fireTouch(el, 'touchmove', { touches: [touchPoint({ pageX: 60, pageY: 0 })] })
		fireTouch(el, 'touchend', { touches: [], changedTouches: [touchPoint({ pageX: 60, pageY: 0 })] })
		await flushGestureEvents()
		expect(typesFor(info.moduleId)).toEqual(['touchmove', 'canceltap', 'touchmove', 'canceltap'])
		expect(typesFor(info.moduleId)).not.toContain('tap')
	})
	it('touchcancel supplies a canceltap after touchcancel when the sequence had not moved yet', () => {
		const info = makeInfo({ bindtouchcancel: 'onTouchCancel', bindcanceltap: 'onCancelTap' })
		const el = mountSingle(info, {})
		fireTouch(el, 'touchstart', { touches: [touchPoint({ pageX: 0, pageY: 0 })] })
		fireTouch(el, 'touchcancel', { touches: [], changedTouches: [touchPoint({ pageX: 0, pageY: 0 })] })
		const types = typesFor(info.moduleId)
		expect(types.indexOf('touchcancel')).toBeGreaterThanOrEqual(0)
		expect(types.indexOf('canceltap')).toBeGreaterThan(types.indexOf('touchcancel'))
		expect(countType(info.moduleId, 'canceltap')).toBe(1)
	})

	it('touchcancel does not duplicate canceltap when movement already triggered one', () => {
		const info = makeInfo({ bindtouchcancel: 'onTouchCancel', bindcanceltap: 'onCancelTap' })
		const el = mountSingle(info, {})
		fireTouch(el, 'touchstart', { touches: [touchPoint({ pageX: 0, pageY: 0 })] })
		fireTouch(el, 'touchmove', { touches: [touchPoint({ pageX: 30, pageY: 0 })] })
		fireTouch(el, 'touchcancel', { touches: [], changedTouches: [touchPoint({ pageX: 30, pageY: 0 })] })
		expect(countType(info.moduleId, 'canceltap')).toBe(1)
	})

	it('honors a custom moveThreshold from the options object', async () => {
		const info = makeInfo({ bindtap: 'onTap', bindcanceltap: 'onCancelTap' })
		const el = mountSingle(info, { moveThreshold: 1000 })
		fireTouch(el, 'touchstart', { touches: [touchPoint({ pageX: 0, pageY: 0 })] })
		fireTouch(el, 'touchmove', { touches: [touchPoint({ pageX: 200, pageY: 0 })] })
		fireTouch(el, 'touchend', { touches: [], changedTouches: [touchPoint({ pageX: 200, pageY: 0 })] })
		await flushGestureEvents()
		expect(typesFor(info.moduleId)).toContain('tap')
		expect(typesFor(info.moduleId)).not.toContain('canceltap')
	})
})

describe('longpress suppresses tap, longtap does not', () => {
	it('fires longtap strictly before longpress when the timer elapses without movement', () => {
		vi.useFakeTimers()
		const info = makeInfo({ bindlongtap: 'onLongTap', bindlongpress: 'onLongPress' })
		const el = mountSingle(info, { longPressThreshold: 50 })
		fireTouch(el, 'touchstart', { touches: [touchPoint({ pageX: 0, pageY: 0 })] })
		vi.advanceTimersByTime(50)
		const types = typesFor(info.moduleId)
		expect(types.indexOf('longtap')).toBeGreaterThanOrEqual(0)
		expect(types.indexOf('longpress')).toBeGreaterThan(types.indexOf('longtap'))
	})

	it('binding longpress suppresses tap for that sequence, while touchend still fires', async () => {
		vi.useFakeTimers()
		const info = makeInfo({ bindlongpress: 'onLongPress', bindtap: 'onTap', bindtouchend: 'onTouchEnd' })
		const el = mountSingle(info, { longPressThreshold: 50 })
		fireTouch(el, 'touchstart', { touches: [touchPoint({ pageX: 0, pageY: 0 })] })
		vi.advanceTimersByTime(50)
		fireTouch(el, 'touchend', { touches: [], changedTouches: [touchPoint({ pageX: 0, pageY: 0 })] })
		await flushGestureEvents()
		const types = typesFor(info.moduleId)
		expect(types).toContain('touchend')
		expect(types).not.toContain('tap')
	})

	it('binding only longtap (no longpress) does not suppress tap', async () => {
		vi.useFakeTimers()
		const info = makeInfo({ bindlongtap: 'onLongTap', bindtap: 'onTap', bindtouchend: 'onTouchEnd' })
		const el = mountSingle(info, { longPressThreshold: 50 })
		fireTouch(el, 'touchstart', { touches: [touchPoint({ pageX: 0, pageY: 0 })] })
		vi.advanceTimersByTime(50)
		fireTouch(el, 'touchend', { touches: [], changedTouches: [touchPoint({ pageX: 0, pageY: 0 })] })
		await flushGestureEvents()
		const types = typesFor(info.moduleId)
		expect(types).toContain('longtap')
		expect(types).toContain('tap')
	})

	it.each([
		['bindlongpress'],
		['bind:longpress'],
		['catchlongpress'],
		['catch:longpress'],
	])('%s suppresses tap regardless of binding syntax', async (key) => {
		vi.useFakeTimers()
		const info = makeInfo({ [key]: 'onLongPress', bindtap: 'onTap' })
		const el = mountSingle(info, { longPressThreshold: 50 })
		fireTouch(el, 'touchstart', { touches: [touchPoint({ pageX: 0, pageY: 0 })] })
		vi.advanceTimersByTime(50)
		fireTouch(el, 'touchend', { touches: [], changedTouches: [touchPoint({ pageX: 0, pageY: 0 })] })
		await flushGestureEvents()
		expect(typesFor(info.moduleId)).not.toContain('tap')
	})

	it('movement beyond moveThreshold cancels the pending long-press timer', () => {
		vi.useFakeTimers()
		const info = makeInfo({ bindlongpress: 'onLongPress', bindlongtap: 'onLongTap' })
		const el = mountSingle(info, { longPressThreshold: 50 })
		fireTouch(el, 'touchstart', { touches: [touchPoint({ pageX: 0, pageY: 0 })] })
		fireTouch(el, 'touchmove', { touches: [touchPoint({ pageX: 40, pageY: 0 })] })
		vi.advanceTimersByTime(50)
		const types = typesFor(info.moduleId)
		expect(types).not.toContain('longpress')
		expect(types).not.toContain('longtap')
	})
})

describe('pointer input synthesizes a touch sequence', () => {
	it('pointerdown/pointermove/pointerup with pointerType "mouse" produce a full sequence and synthesize tap', async () => {
		const info = makeInfo({ bindtouchstart: 'onTouchStart', bindtouchmove: 'onTouchMove', bindtouchend: 'onTouchEnd', bindtap: 'onTap' })
		const el = mountSingle(info, {})
		fire(el, 'pointerdown', { pointerType: 'mouse', pointerId: 1, pageX: 5, pageY: 5, clientX: 5, clientY: 5 })
		fire(document, 'pointermove', { pointerType: 'mouse', pointerId: 1, pageX: 6, pageY: 5, clientX: 6, clientY: 5 })
		fire(document, 'pointerup', { pointerType: 'mouse', pointerId: 1, pageX: 6, pageY: 5, clientX: 6, clientY: 5 })
		await flushGestureEvents()

		const sent = sentFor(info.moduleId)
		expect(sent.map(b => b.event.type)).toEqual(['touchstart', 'touchmove', 'touchend', 'tap'])
		const touchStart = sent.find(b => b.event.type === 'touchstart')
		expect(touchStart.event.touches[0].identifier).toBe(0)
		const tapCall = sent.find(b => b.event.type === 'tap')
		expect(tapCall.event.detail.x).toBe(6)
		expect(tapCall.event.detail.y).toBe(5)
	})

	it('a pointer sequence that moves outside the element is tracked via document-level pointermove/pointerup and still terminates cleanly for the next sequence', async () => {
		const info = makeInfo({ bindtap: 'onTap' })
		const el = mountSingle(info, {})
		// pointermove/pointerup are dispatched on `document`, not on `el`, because once the
		// pointer leaves the element it can no longer receive events directly.
		fire(el, 'pointerdown', { pointerType: 'mouse', pointerId: 1, pageX: 0, pageY: 0, clientX: 0, clientY: 0 })
		fire(document, 'pointermove', { pointerType: 'mouse', pointerId: 1, pageX: 500, pageY: 500, clientX: 500, clientY: 500 })
		fire(document, 'pointerup', { pointerType: 'mouse', pointerId: 1, pageX: 500, pageY: 500, clientX: 500, clientY: 500 })
		await flushGestureEvents()
		expect(typesFor(info.moduleId)).not.toContain('tap')

		fire(el, 'pointerdown', { pointerType: 'mouse', pointerId: 1, pageX: 0, pageY: 0, clientX: 0, clientY: 0 })
		fire(document, 'pointerup', { pointerType: 'mouse', pointerId: 1, pageX: 0, pageY: 0, clientX: 0, clientY: 0 })
		await flushGestureEvents()
		expect(countType(info.moduleId, 'tap')).toBe(1)
	})

	it('ignores pointer events whose pointerType is "touch"', () => {
		const info = makeInfo({ bindtouchstart: 'onTouchStart', bindtap: 'onTap' })
		const el = mountSingle(info, {})
		fire(el, 'pointerdown', { pointerType: 'touch', pointerId: 1, pageX: 0, pageY: 0 })
		fire(document, 'pointermove', { pointerType: 'touch', pointerId: 1, pageX: 0, pageY: 0 })
		fire(document, 'pointerup', { pointerType: 'touch', pointerId: 1, pageX: 0, pageY: 0 })
		expect(sentFor(info.moduleId)).toEqual([])
	})

	it('does not double-dispatch when a real touch sequence is accompanied by pointerType "touch" events', async () => {
		const info = makeInfo({ bindtouchstart: 'onTouchStart', bindtouchend: 'onTouchEnd', bindtap: 'onTap' })
		const el = mountSingle(info, {})
		fire(el, 'pointerdown', { pointerType: 'touch', pointerId: 1, pageX: 0, pageY: 0 })
		fireTouch(el, 'touchstart', { touches: [touchPoint({ pageX: 0, pageY: 0 })] })
		fireTouch(el, 'touchend', { touches: [], changedTouches: [touchPoint({ pageX: 0, pageY: 0 })] })
		fire(document, 'pointerup', { pointerType: 'touch', pointerId: 1, pageX: 0, pageY: 0 })
		await flushGestureEvents()
		expect(countType(info.moduleId, 'touchstart')).toBe(1)
		expect(countType(info.moduleId, 'touchend')).toBe(1)
		expect(countType(info.moduleId, 'tap')).toBe(1)
	})
})

describe('click fallback', () => {
	it('programmatic el.click() dispatches tap when there was no recent pointer/touch sequence', () => {
		const info = makeInfo({ bindtap: 'onTap' })
		const el = mountSingle(info, {})
		el.click()
		expect(countType(info.moduleId, 'tap')).toBe(1)
	})

	it('a click carrying a click count does not duplicate the tap its own pointer sequence produced', async () => {
		const info = makeInfo({ bindtap: 'onTap' })
		const el = mountSingle(info, {})
		fire(el, 'pointerdown', { pointerType: 'mouse', pointerId: 1, pageX: 0, pageY: 0 })
		fire(document, 'pointerup', { pointerType: 'mouse', pointerId: 1, pageX: 0, pageY: 0 })
		await flushGestureEvents()
		expect(countType(info.moduleId, 'tap')).toBe(1)

		fire(el, 'click', { detail: 1 })
		expect(countType(info.moduleId, 'tap')).toBe(1)
	})

	it('a programmatic click right after a pointer sequence is a separate interaction and dispatches tap', async () => {
		// devtools 自动化的 element.tap() 就是 el.click()，detail 为 0；
		// 判据只看 detail，不看距离上一次序列多久，脚本连点才不会被静默吞掉。
		const info = makeInfo({ bindtap: 'onTap' })
		const el = mountSingle(info, {})
		fire(el, 'pointerdown', { pointerType: 'mouse', pointerId: 1, pageX: 0, pageY: 0 })
		fire(document, 'pointerup', { pointerType: 'mouse', pointerId: 1, pageX: 0, pageY: 0 })
		await flushGestureEvents()
		fire(el, 'click', { detail: 1 })
		expect(countType(info.moduleId, 'tap')).toBe(1)

		el.click()
		expect(countType(info.moduleId, 'tap')).toBe(2)
	})

	it('a click forwarded by a native label carries no click count and dispatches tap', () => {
		// 浏览器转发给控件的 click 与程序化 click 一样 detail 为 0：
		// 手势层无法区分，所以转发必须在 label 那侧就被取消。
		const info = makeInfo({ bindtap: 'onTap' })
		const el = mountSingle(info, {})
		fire(el, 'click', { detail: 0 })
		expect(countType(info.moduleId, 'tap')).toBe(1)
	})
})

describe('catch blocks tap bubbling without swallowing touchend', () => {
	it('catch:tap on a descendant blocks the ancestor tap while the ancestor still receives bindtouchend', async () => {
		const ancestorInfo = makeInfo({ bindtap: 'onAncestorTap', bindtouchend: 'onAncestorTouchEnd' })
		const descendantInfo = makeInfo({ 'catch:tap': 'onDescendantCatchTap' })
		const { descendantEl } = mountNested({ ancestorInfo, descendantInfo })

		fireTouch(descendantEl, 'touchstart', { touches: [touchPoint({ pageX: 0, pageY: 0 })] })
		fireTouch(descendantEl, 'touchend', { touches: [], changedTouches: [touchPoint({ pageX: 0, pageY: 0 })] })
		await flushGestureEvents()

		expect(typesFor(descendantInfo.moduleId)).toContain('tap')
		expect(typesFor(ancestorInfo.moduleId)).not.toContain('tap')
		expect(typesFor(ancestorInfo.moduleId)).toContain('touchend')
	})

	it('catchtap (no colon) on a descendant also blocks the ancestor tap', async () => {
		const ancestorInfo = makeInfo({ bindtap: 'onAncestorTap' })
		const descendantInfo = makeInfo({ catchtap: 'onDescendantCatchTap' })
		const { descendantEl } = mountNested({ ancestorInfo, descendantInfo })

		fireTouch(descendantEl, 'touchstart', { touches: [touchPoint({ pageX: 0, pageY: 0 })] })
		fireTouch(descendantEl, 'touchend', { touches: [], changedTouches: [touchPoint({ pageX: 0, pageY: 0 })] })
		await flushGestureEvents()

		expect(typesFor(ancestorInfo.moduleId)).not.toContain('tap')
	})
})

describe('canvas semantics: normal bubbling + relativeTo', () => {
	it('touch events bubble to the ancestor and carry currentTarget at both levels', () => {
		const ancestorInfo = makeInfo({ bindtouchstart: 'onAncestorTouchStart' })
		const descendantInfo = makeInfo({ bindtouchstart: 'onDescendantTouchStart' })
		const { descendantEl } = mountNested({ ancestorInfo, descendantInfo })

		fireTouch(descendantEl, 'touchstart', { touches: [touchPoint({ pageX: 0, pageY: 0 })] })

		expect(typesFor(ancestorInfo.moduleId)).toContain('touchstart')
		const descendantTouchStart = sentFor(descendantInfo.moduleId).find(b => b.event.type === 'touchstart')
		const ancestorTouchStart = sentFor(ancestorInfo.moduleId).find(b => b.event.type === 'touchstart')
		expect(descendantTouchStart.event).toHaveProperty('currentTarget')
		expect(ancestorTouchStart.event).toHaveProperty('currentTarget')
	})

	it('finishes touchend bubbling before tap bubbles, with currentTarget on both levels', async () => {
		const ancestorInfo = makeInfo({ bindtouchend: 'onAncestorEnd', bindtap: 'onAncestorTap' })
		const descendantInfo = makeInfo({ bindtouchend: 'onDescendantEnd', bindtap: 'onDescendantTap' })
		const { descendantEl } = mountNested({ ancestorInfo, descendantInfo })

		fireTouch(descendantEl, 'touchstart', { touches: [touchPoint({ pageX: 0, pageY: 0 })] })
		fireTouch(descendantEl, 'touchend', { touches: [], changedTouches: [touchPoint({ pageX: 0, pageY: 0 })] })
		await flushGestureEvents()

		const order = window.__message.send.mock.calls.map(([message]) => {
			const owner = message.body.moduleId === descendantInfo.moduleId ? 'descendant' : 'ancestor'
			return `${owner}:${message.body.event.type}`
		})
		expect(order).toEqual(['descendant:touchend', 'ancestor:touchend', 'descendant:tap', 'ancestor:tap'])
		for (const body of [...sentFor(descendantInfo.moduleId), ...sentFor(ancestorInfo.moduleId)]) {
			expect(body.event).toHaveProperty('currentTarget')
		}
	})

	it('relativeTo adds relative x/y to every touch point without disturbing the 8 standard fields', () => {
		const info = makeInfo({ bindtouchstart: 'onTouchStart' })
		const { rootEl } = mountCanvasLike(info, {}, { left: 50, top: 30 })

		const point = touchPoint({ identifier: 3, pageX: 130, pageY: 90, clientX: 120, clientY: 80, screenX: 200, screenY: 150, force: 0.7 })
		fireTouch(rootEl, 'touchstart', { touches: [point] })

		const call = sentFor(info.moduleId).find(b => b.event.type === 'touchstart')
		expect(call.event.touches[0]).toMatchObject(std8(point))
		expect(call.event.touches[0].x).toBe(70)
		expect(call.event.touches[0].y).toBe(50)
	})
})

describe('touch events carrying no touch points', () => {
	it('a touchstart/touchend pair with empty touches/changedTouches does not throw and still completes the sequence at the origin', async () => {
		// devtools' automator longpress() dispatches `new TouchEvent('touchstart', { bubbles: true })`
		// with no touch points at all; the handler must not assume touches[0]/changedTouches[0] exist.
		const info = makeInfo({ bindtouchstart: 'onTouchStart', bindtouchend: 'onTouchEnd', bindtap: 'onTap' })
		const el = mountSingle(info, {})

		expect(() => {
			fireTouch(el, 'touchstart', { touches: [], changedTouches: [] })
			fireTouch(el, 'touchend', { touches: [], changedTouches: [] })
		}).not.toThrow()
		await flushGestureEvents()

		const types = typesFor(info.moduleId)
		expect(types).toContain('touchstart')
		expect(types).toContain('touchend')
		expect(types).toContain('tap')

		const tapCall = sentFor(info.moduleId).find(b => b.event.type === 'tap')
		expect(tapCall.event.detail.x).toBe(0)
		expect(tapCall.event.detail.y).toBe(0)
	})
})
