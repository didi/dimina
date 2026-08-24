/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { attachTouchEvents } from '../src/common/touchGestures.js'
let moduleCounter = 0
let detachHandlers = []
function makeInfo(attrs) {
	moduleCounter += 1
	return {
		attrs,
		bridgeId: 'bridge-touch-regression',
		moduleId: `touch-regression-${moduleCounter}`,
		path: '/pages/index/index',
	}
}
function point(identifier, x, y = 0) {
	return {
		identifier,
		clientX: x,
		clientY: y,
		pageX: x,
		pageY: y,
		screenX: x,
		screenY: y,
		force: 1,
	}
}
function fireTouch(target, type, touches, changedTouches = touches) {
	const event = new Event(type, { bubbles: true, cancelable: true })
	Object.assign(event, { touches, changedTouches, targetTouches: touches })
	target.dispatchEvent(event)
	return event
}
function firePointer(target, type, props = {}) {
	const event = new Event(type, { bubbles: true, cancelable: true })
	Object.assign(event, { pointerType: 'mouse', pointerId: 1, button: 0, ...props })
	target.dispatchEvent(event)
	return event
}
function mount(info, options = {}) {
	const element = document.createElement('div')
	document.body.append(element)
	detachHandlers.push(attachTouchEvents(info, element, options))
	return element
}
function mountNested(ancestorInfo, childInfo) {
	const ancestor = document.createElement('div')
	const child = document.createElement('div')
	ancestor.append(child)
	document.body.append(ancestor)
	detachHandlers.push(attachTouchEvents(ancestorInfo, ancestor))
	detachHandlers.push(attachTouchEvents(childInfo, child))
	return { ancestor, child }
}
function eventTypes(moduleId) {
	return window.__message.send.mock.calls
		.filter(([message]) => message.body.moduleId === moduleId)
		.map(([message]) => message.body.event.type)
}
function flushGestureEvents() {
	return new Promise(resolve => queueMicrotask(resolve))
}
beforeEach(() => {
	window.__message = { send: vi.fn(), invoke: vi.fn(), on: vi.fn(), off: vi.fn() }
	window.__callback = { store: vi.fn(), remove: vi.fn() }
})
afterEach(() => {
	for (const detach of detachHandlers) detach()
	detachHandlers = []
	vi.useRealTimers()
	document.body.innerHTML = ''
})
describe('touch gesture state regressions', () => {
	it('keeps updating movement and cancels tap after catchtouchmove disables native scrolling', async () => {
		vi.useFakeTimers()
		const info = makeInfo({
			catchtouchmove: 'onTouchMove',
			bindtap: 'onTap',
			bindcanceltap: 'onCancelTap',
			bindlongpress: 'onLongPress',
		})
		const element = mount(info, { longPressThreshold: 50, moveThreshold: 10 })
		Object.defineProperties(element, {
			scrollHeight: { configurable: true, value: 200 },
			clientHeight: { configurable: true, value: 100 },
			scrollTop: { configurable: true, value: 0 },
		})
		fireTouch(element, 'touchstart', [point(1, 0, 0)])
		const boundaryMove = fireTouch(element, 'touchmove', [point(1, 0, 1)])
		const largeMove = fireTouch(element, 'touchmove', [point(1, 0, 30)])
		vi.advanceTimersByTime(50)
		fireTouch(element, 'touchend', [], [point(1, 0, 30)])
		await flushGestureEvents()
		const types = eventTypes(info.moduleId)
		expect(boundaryMove.defaultPrevented).toBe(true)
		expect(largeMove.defaultPrevented).toBe(true)
		expect(types.filter(type => type === 'touchmove')).toHaveLength(2)
		expect(types.filter(type => type === 'canceltap')).toHaveLength(1)
		expect(types).not.toContain('tap')
		expect(types).not.toContain('longpress')
	})
	it('keeps the first touch tappable when a second touch joins, and only suppresses longpress', async () => {
		vi.useFakeTimers()
		const info = makeInfo({
			bindtouchstart: 'onTouchStart',
			bindtouchend: 'onTouchEnd',
			bindtap: 'onTap',
			bindcanceltap: 'onCancelTap',
			bindlongpress: 'onLongPress',
		})
		const element = mount(info, { longPressThreshold: 50 })
		const first = point(11, 10, 10)
		const second = point(22, 20, 20)
		fireTouch(element, 'touchstart', [first], [first])
		fireTouch(element, 'touchstart', [first, second], [second])
		vi.advanceTimersByTime(50)
		fireTouch(element, 'touchend', [first], [second])
		fireTouch(element, 'touchend', [], [first])
		await flushGestureEvents()
		const types = eventTypes(info.moduleId)
		expect(types.filter(type => type === 'touchstart')).toHaveLength(2)
		expect(types.filter(type => type === 'touchend')).toHaveLength(2)
		// glass-easel keeps one possibleTaps entry per identifier: the second finger
		// neither deletes the first finger's entry nor emits canceltap for it.
		expect(types.filter(type => type === 'tap')).toHaveLength(1)
		expect(types).not.toContain('canceltap')
		expect(types).not.toContain('longpress')
	})
	it('lets an ancestor advance movement state behind a child catchtouchmove without dispatching the caught touchmove', async () => {
		const ancestorInfo = makeInfo({ bindtap: 'onTap', bindcanceltap: 'onCancelTap', bindtouchmove: 'onMove' })
		const childInfo = makeInfo({ catchtouchmove: 'catchMove' })
		const { child } = mountNested(ancestorInfo, childInfo)
		fireTouch(child, 'touchstart', [point(1, 0)])
		fireTouch(child, 'touchmove', [point(1, 30)])
		fireTouch(child, 'touchend', [], [point(1, 30)])
		await flushGestureEvents()
		const ancestorTypes = eventTypes(ancestorInfo.moduleId)
		expect(ancestorTypes).not.toContain('touchmove')
		expect(ancestorTypes).toContain('canceltap')
		expect(ancestorTypes).not.toContain('tap')
	})
	it('does not let pointer input take over an active touch sequence', async () => {
		const info = makeInfo({ bindtouchstart: 'onStart', bindtouchend: 'onEnd', bindtap: 'onTap' })
		const element = mount(info)
		fireTouch(element, 'touchstart', [point(7, 0)])
		const down = new Event('pointerdown', { bubbles: true })
		Object.assign(down, { pointerType: 'mouse', pointerId: 9, button: 0, clientX: 100, clientY: 0, pageX: 100, pageY: 0 })
		element.dispatchEvent(down)
		fireTouch(element, 'touchend', [], [point(7, 0)])
		await flushGestureEvents()
		expect(eventTypes(info.moduleId)).toEqual(['touchstart', 'touchend', 'tap'])
	})
	it('commits touch termination before dispatch so a reentrant second sequence keeps touch ownership', async () => {
		const info = makeInfo({ bindtouchstart: 'onStart', bindtouchend: 'onEnd', bindtap: 'onTap' })
		const element = mount(info)
		let reentered = false
		window.__message.send.mockImplementation((message) => {
			if (!reentered && message.body.event.type === 'touchend') {
				reentered = true
				fireTouch(element, 'touchstart', [point(2, 20)])
			}
		})

		fireTouch(element, 'touchstart', [point(1, 10)])
		fireTouch(element, 'touchend', [], [point(1, 10)])
		firePointer(element, 'pointerdown', { pointerId: 9, clientX: 90, pageX: 90 })
		fireTouch(element, 'touchend', [], [point(2, 20)])

		await flushGestureEvents()
		expect(eventTypes(info.moduleId).filter(type => type === 'tap')).toHaveLength(2)
	})

	it('keeps the ancestor tap suppressed when a descendant longpress owns the same native sequence', async () => {
		vi.useFakeTimers()
		const ancestorInfo = makeInfo({ bindtap: 'onAncestorTap' })
		const childInfo = makeInfo({ bindlongpress: 'onChildLongPress' })
		const { child } = mountNested(ancestorInfo, childInfo)

		fireTouch(child, 'touchstart', [point(1, 10)])
		vi.advanceTimersByTime(350)
		fireTouch(child, 'touchend', [], [point(1, 10)])
		await flushGestureEvents()

		expect(eventTypes(childInfo.moduleId)).toContain('longpress')
		expect(eventTypes(ancestorInfo.moduleId)).not.toContain('tap')
	})

	it('commits touch cancellation before dispatch so a reentrant sequence survives', async () => {
		const info = makeInfo({ bindtouchstart: 'onStart', bindtouchcancel: 'onCancel', bindcanceltap: 'onCancelTap', bindtap: 'onTap' })
		const element = mount(info)
		let reentered = false
		window.__message.send.mockImplementation((message) => {
			if (!reentered && message.body.event.type === 'touchcancel') {
				reentered = true
				fireTouch(element, 'touchstart', [point(2, 20)])
			}
		})

		fireTouch(element, 'touchstart', [point(1, 10)])
		fireTouch(element, 'touchcancel', [], [point(1, 10)])
		firePointer(element, 'pointerdown', { pointerId: 9, clientX: 90, pageX: 90 })
		fireTouch(element, 'touchend', [], [point(2, 20)])

		await flushGestureEvents()
		const types = eventTypes(info.moduleId)
		expect(types.filter(type => type === 'canceltap')).toHaveLength(1)
		expect(types.filter(type => type === 'tap')).toHaveLength(1)
	})

	it('does not swallow a programmatic click after touchcancel', () => {
		const info = makeInfo({ bindtap: 'onTap', bindtouchcancel: 'onCancel' })
		const element = mount(info)
		fireTouch(element, 'touchstart', [point(1, 0)])
		fireTouch(element, 'touchcancel', [], [point(1, 0)])
		element.click()

		expect(eventTypes(info.moduleId)).toContain('tap')
	})

	it('keeps exact counts across rapid consecutive touch sequences', async () => {
		const info = makeInfo({ bindtouchstart: 'onStart', bindtouchend: 'onEnd', bindtap: 'onTap', bindcanceltap: 'onCancelTap' })
		const element = mount(info)

		for (let identifier = 1; identifier <= 20; identifier += 1) {
			fireTouch(element, 'touchstart', [point(identifier, identifier)])
			fireTouch(element, 'touchend', [], [point(identifier, identifier)])
		}

		await flushGestureEvents()
		const types = eventTypes(info.moduleId)
		expect(types.filter(type => type === 'touchstart')).toHaveLength(20)
		expect(types.filter(type => type === 'touchend')).toHaveLength(20)
		expect(types.filter(type => type === 'tap')).toHaveLength(20)
		expect(types).not.toContain('canceltap')
	})

	it('does not start a second single-touch gesture while earlier contacts are still down', async () => {
		vi.useFakeTimers()
		const info = makeInfo({ bindtap: 'onTap', bindlongpress: 'onLongPress', bindcanceltap: 'onCancelTap' })
		const element = mount(info, { longPressThreshold: 50 })
		const first = point(1, 10)
		const second = point(2, 20)
		const third = point(3, 30)

		fireTouch(element, 'touchstart', [first], [first])
		fireTouch(element, 'touchstart', [first, second], [second])
		fireTouch(element, 'touchend', [second], [first])
		fireTouch(element, 'touchstart', [second, third], [third])
		vi.advanceTimersByTime(50)
		fireTouch(element, 'touchend', [second], [third])
		fireTouch(element, 'touchend', [], [second])
		await flushGestureEvents()

		const types = eventTypes(info.moduleId)
		// Only the first contact ever owned a sequence, so it is the only tap; the
		// third touchstart lands while contacts remain and starts nothing of its own.
		expect(types.filter(type => type === 'tap')).toHaveLength(1)
		expect(types).not.toContain('canceltap')
		expect(types).not.toContain('longpress')
	})

	it('cancels pointer ownership on window blur so the next sequence can start', async () => {
		const info = makeInfo({ bindtouchcancel: 'onCancel', bindcanceltap: 'onCancelTap', bindtap: 'onTap' })
		const element = mount(info)

		firePointer(element, 'pointerdown', { clientX: 10, clientY: 10, pageX: 10, pageY: 10 })
		window.dispatchEvent(new Event('blur'))
		firePointer(element, 'pointerdown', { pointerId: 2, clientX: 20, clientY: 20, pageX: 20, pageY: 20 })
		firePointer(document, 'pointerup', { pointerId: 2, clientX: 20, clientY: 20, pageX: 20, pageY: 20 })

		await flushGestureEvents()
		const types = eventTypes(info.moduleId)
		expect(types.filter(type => type === 'touchcancel')).toHaveLength(1)
		expect(types.filter(type => type === 'canceltap')).toHaveLength(1)
		expect(types.filter(type => type === 'tap')).toHaveLength(1)
	})

	it('does not let an ancestor scroll across a descendant catchtouchmove boundary', () => {
		const info = makeInfo({ catchtouchmove: 'onMove' })
		const ancestor = document.createElement('div')
		const element = document.createElement('div')
		ancestor.append(element)
		document.body.append(ancestor)
		Object.defineProperties(ancestor, {
			scrollHeight: { configurable: true, value: 300 },
			clientHeight: { configurable: true, value: 100 },
			scrollTop: { configurable: true, writable: true, value: 50 },
		})
		detachHandlers.push(attachTouchEvents(info, element))

		fireTouch(element, 'touchstart', [point(1, 0, 100)])
		const move = fireTouch(element, 'touchmove', [point(1, 0, 50)])

		expect(move.defaultPrevented).toBe(true)
	})

	it('reevaluates scroll direction from the previous move after the finger reverses', () => {
		const info = makeInfo({ catchtouchmove: 'onMove' })
		const element = mount(info)
		element.style.overflowY = 'scroll'
		Object.defineProperties(element, {
			scrollHeight: { configurable: true, value: 200 },
			clientHeight: { configurable: true, value: 100 },
			scrollTop: { configurable: true, writable: true, value: 100 },
		})

		fireTouch(element, 'touchstart', [point(1, 0, 100)])
		const downward = fireTouch(element, 'touchmove', [point(1, 0, 150)])
		const reversedAtBottom = fireTouch(element, 'touchmove', [point(1, 0, 140)])

		expect(downward.defaultPrevented).toBe(false)
		expect(reversedAtBottom.defaultPrevented).toBe(true)
	})

	it('ignores touch phases that race with an active mouse pointer sequence', async () => {
		const info = makeInfo({ bindtouchstart: 'onStart', bindtouchmove: 'onMove', bindtouchend: 'onEnd', bindtap: 'onTap' })
		const element = mount(info)

		firePointer(element, 'pointerdown', { clientX: 10, clientY: 0, pageX: 10, pageY: 0 })
		fireTouch(element, 'touchmove', [point(7, 50)])
		fireTouch(element, 'touchend', [], [point(7, 50)])
		firePointer(document, 'pointerup', { clientX: 10, clientY: 0, pageX: 10, pageY: 0 })

		await flushGestureEvents()
		expect(eventTypes(info.moduleId)).toEqual(['touchstart', 'touchend', 'tap'])
	})

	it('does not synthesize gestures and conservatively blocks the first move when installed mid-sequence', () => {
		const info = makeInfo({ bindtouchstart: 'onStart', catchtouchmove: 'onMove', bindtouchend: 'onEnd', bindcanceltap: 'onCancelTap', bindtap: 'onTap' })
		const element = mount(info)
		Object.defineProperties(element, {
			scrollWidth: { configurable: true, value: 200 },
			clientWidth: { configurable: true, value: 100 },
			scrollLeft: { configurable: true, value: 50 },
		})
		fireTouch(element, 'touchstart', [point(1, 0)])
		element.__ddGestureDetach()
		detachHandlers.push(attachTouchEvents(info, element))

		const move = fireTouch(element, 'touchmove', [point(1, 30)])
		fireTouch(element, 'touchend', [], [point(1, 30)])

		expect(move.defaultPrevented).toBe(true)
		expect(eventTypes(info.moduleId)).toEqual(['touchstart', 'touchmove', 'touchend'])
	})

	it('does not swallow an independent programmatic click after a dragged touch sequence', () => {
		const info = makeInfo({ bindcanceltap: 'onCancelTap', bindtap: 'onTap' })
		const element = mount(info)
		fireTouch(element, 'touchstart', [point(1, 0)])
		fireTouch(element, 'touchmove', [point(1, 30)])
		fireTouch(element, 'touchend', [], [point(1, 30)])
		element.click()

		const types = eventTypes(info.moduleId)
		expect(types.filter(type => type === 'canceltap')).toHaveLength(1)
		expect(types.filter(type => type === 'tap')).toHaveLength(1)
	})

	it('keeps a reentrant touchcancel payload owned by the cancelled sequence', async () => {
		const info = makeInfo({ bindtouchstart: 'onStart', bindtouchcancel: 'onCancel', bindcanceltap: 'onCancelTap', bindtap: 'onTap' })
		const element = mount(info)
		let reentered = false
		window.__message.send.mockImplementation((message) => {
			if (!reentered && message.body.event.type === 'touchcancel') {
				reentered = true
				fireTouch(element, 'touchstart', [point(2, 20)])
			}
		})

		fireTouch(element, 'touchstart', [point(1, 10)])
		fireTouch(element, 'touchcancel', [], [point(1, 10)])
		fireTouch(element, 'touchend', [], [point(2, 20)])

		await flushGestureEvents()
		const bodies = window.__message.send.mock.calls.map(([message]) => message.body)
		const cancelTap = bodies.find(body => body.event.type === 'canceltap')
		expect(cancelTap.event.touches.map(touch => touch.identifier)).toEqual([1])
		expect(eventTypes(info.moduleId).filter(type => type === 'tap')).toHaveLength(1)
	})

	it('blocks horizontal overscroll at the boundary and reevaluates after scrollLeft changes', () => {
		const info = makeInfo({ catchtouchmove: 'onMove' })
		const element = mount(info)
		element.style.overflowX = 'scroll'
		Object.defineProperties(element, {
			scrollWidth: { configurable: true, value: 200 },
			clientWidth: { configurable: true, value: 100 },
			scrollLeft: { configurable: true, writable: true, value: 0 },
		})
		fireTouch(element, 'touchstart', [point(1, 0)])
		const boundaryMove = fireTouch(element, 'touchmove', [point(1, 30)])
		element.scrollLeft = 50
		const movable = fireTouch(element, 'touchmove', [point(1, 40)])

		expect(boundaryMove.defaultPrevented).toBe(true)
		expect(movable.defaultPrevented).toBe(false)
	})

	it('lets an ancestor longpress suppress the descendant tap on their shared sequence', async () => {
		vi.useFakeTimers()
		const ancestorInfo = makeInfo({ bindlongpress: 'onLongPress' })
		const childInfo = makeInfo({ bindtap: 'onTap' })
		const ancestor = document.createElement('div')
		const child = document.createElement('canvas')
		ancestor.append(child)
		document.body.append(ancestor)
		detachHandlers.push(attachTouchEvents(ancestorInfo, ancestor, { longPressThreshold: 50 }))
		detachHandlers.push(attachTouchEvents(childInfo, child, { longPressThreshold: 50 }))

		fireTouch(child, 'touchstart', [point(1, 10)])
		vi.advanceTimersByTime(50)
		fireTouch(child, 'touchend', [], [point(1, 10)])
		await flushGestureEvents()

		expect(eventTypes(ancestorInfo.moduleId)).toContain('longpress')
		expect(eventTypes(childInfo.moduleId)).not.toContain('tap')
	})

	it('uses the current native target when a raw multi-touch sequence follows another sequence', () => {
		const info = makeInfo({ bindtouchstart: 'onStart' })
		const element = mount(info)
		const first = document.createElement('div')
		const second = document.createElement('div')
		first.id = 'first'
		second.id = 'second'
		element.append(first, second)
		fireTouch(first, 'touchstart', [point(1, 10)])
		fireTouch(first, 'touchend', [], [point(1, 10)])
		fireTouch(second, 'touchstart', [point(2, 20), point(3, 30)], [point(2, 20), point(3, 30)])

		const starts = window.__message.send.mock.calls
			.map(([message]) => message.body)
			.filter(body => body.moduleId === info.moduleId && body.event.type === 'touchstart')
		expect(starts.at(-1).event.target.id).toBe('second')
	})

	it('delivers pointer blur cancellation to both descendant and ancestor owners', () => {
		const ancestorInfo = makeInfo({ bindtouchcancel: 'onCancel' })
		const childInfo = makeInfo({ bindtouchcancel: 'onCancel' })
		const ancestor = document.createElement('div')
		const child = document.createElement('canvas')
		ancestor.append(child)
		document.body.append(ancestor)
		detachHandlers.push(attachTouchEvents(ancestorInfo, ancestor))
		detachHandlers.push(attachTouchEvents(childInfo, child))

		firePointer(child, 'pointerdown', { clientX: 10, pageX: 10 })
		window.dispatchEvent(new Event('blur'))

		expect(eventTypes(childInfo.moduleId)).toContain('touchcancel')
		expect(eventTypes(ancestorInfo.moduleId)).toContain('touchcancel')
	})

	it('leaves the browser default intact when touchstart is caught', () => {
		// catch 只阻止小程序事件冒泡。取消 touchstart 的默认行为会连带取消兼容鼠标事件，
		// 子树里的原生 input 将无法靠触摸聚焦；阻止滚动是 catchtouchmove 的事。
		const info = makeInfo({ catchtouchstart: 'onStart' })
		const element = mount(info)
		const start = fireTouch(element, 'touchstart', [point(1, 10)])
		expect(start.defaultPrevented).toBe(false)
	})

	it('allows an RTL scroller to consume horizontal movement away from its boundary', () => {
		const info = makeInfo({ catchtouchmove: 'onMove' })
		const element = mount(info)
		element.style.overflowX = 'scroll'
		element.style.direction = 'rtl'
		Object.defineProperties(element, {
			scrollWidth: { configurable: true, value: 200 },
			clientWidth: { configurable: true, value: 100 },
			scrollLeft: { configurable: true, writable: true, value: -50 },
		})
		fireTouch(element, 'touchstart', [point(1, 0)])
		const move = fireTouch(element, 'touchmove', [point(1, 10)])
		expect(move.defaultPrevented).toBe(false)
	})

	it.each(['visible', 'hidden'])('does not treat overflow:%s content as a native scroll consumer', (overflowY) => {
		const info = makeInfo({ catchtouchmove: 'onMove' })
		const element = mount(info)
		element.style.overflowY = overflowY
		Object.defineProperties(element, {
			scrollHeight: { configurable: true, value: 200 },
			clientHeight: { configurable: true, value: 100 },
			scrollTop: { configurable: true, value: 0 },
		})
		fireTouch(element, 'touchstart', [point(1, 0, 100)])
		const move = fireTouch(element, 'touchmove', [point(1, 0, 90)])
		expect(move.defaultPrevented).toBe(true)
	})

	it('stops terminal synthesis when touchend synchronously detaches the owner', async () => {
		const info = makeInfo({ bindtouchend: 'onEnd', bindtap: 'onTap' })
		const element = mount(info)
		window.__message.send.mockImplementation(() => element.__ddGestureDetach())
		fireTouch(element, 'touchstart', [point(1, 10)])
		fireTouch(element, 'touchend', [], [point(1, 10)])
		await flushGestureEvents()
		expect(eventTypes(info.moduleId)).toEqual(['touchend'])
	})

	// 手势判定只能依据本节点自己见过的触点。屏幕上还有别处的手指时 event.touches 不为空，
	// 拿它当判据会让 owner 一直以为自己的序列没结束，随后一次干净的单指点击被整个吞掉。
	it('starts a tap sequence while an unrelated contact is held on another element', async () => {
		const info = makeInfo({ bindtap: 'onTap' })
		const element = mount(info)
		const outside = document.createElement('div')
		document.body.append(outside)
		const held = point(9, 300)
		const contact = point(1, 10)

		fireTouch(outside, 'touchstart', [held], [held])
		fireTouch(element, 'touchstart', [held, contact], [contact])
		fireTouch(element, 'touchend', [held], [contact])
		await flushGestureEvents()

		expect(eventTypes(info.moduleId)).toContain('tap')
	})

	it('releases touch ownership when its own contacts are gone even if another element still holds one', async () => {
		const info = makeInfo({ bindtap: 'onTap' })
		const element = mount(info)
		const outside = document.createElement('div')
		document.body.append(outside)
		const contact = point(1, 10)
		const held = point(2, 300)

		fireTouch(element, 'touchstart', [contact], [contact])
		// 别处按下再抬起，本节点两次都收不到事件，只在自己的 touchend 里看见 event.touches 非空。
		fireTouch(outside, 'touchstart', [contact, held], [held])
		fireTouch(element, 'touchend', [held], [contact])
		fireTouch(outside, 'touchend', [], [held])
		await flushGestureEvents()
		window.__message.send.mockClear()

		const next = point(3, 10)
		fireTouch(element, 'touchstart', [next], [next])
		fireTouch(element, 'touchend', [], [next])
		await flushGestureEvents()

		expect(eventTypes(info.moduleId)).toContain('tap')
	})
})
