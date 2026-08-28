/** @vitest-environment jsdom */

// 节点卸载时若原生序列仍在进行，手势所有者会等真实的 touchend / touchcancel 再摘除，
// 好让这次触摸仍以真实终态收口。长按不属于这一类：它由所有者自己的计时器合成，
// 卸载之后再派发就是给一个已经不存在的节点补造事件。
// 组件路径（useTouchEvents）和原生 canvas 指令路径（c-event-node）各有一套安装逻辑，都要覆盖。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, provide, ref, resolveDirective, withDirectives } from 'vue'
import { Components } from '../index.js'
import { useInfo } from '../src/common/events.js'
import { useTouchEvents } from '../src/common/useTouchEvents.js'

const BRIDGE_ID = 'bridge-1'
const PATH = '/pages/index/index'
const MODULE_ID = 'module-1'
const LONG_PRESS_THRESHOLD = 350

let mounted = null

function point(x = 0, y = 0) {
	return { identifier: 0, clientX: x, clientY: y, pageX: x, pageY: y, screenX: x, screenY: y, force: 1 }
}

function fireTouch(target, type, { touches = [], changedTouches = touches } = {}) {
	const event = new Event(type, { bubbles: true, cancelable: true })
	Object.assign(event, { touches, changedTouches, targetTouches: touches })
	target.dispatchEvent(event)
	return event
}

function mountApp(render) {
	const container = document.createElement('div')
	document.body.append(container)
	const app = createApp({
		setup() {
			provide('bridgeId', BRIDGE_ID)
			provide('path', PATH)
			provide(PATH, { id: MODULE_ID })
			return render
		},
	})
	app.use(Components)
	app.mount(container)
	mounted = { app, container }
	return container
}

function eventTypes() {
	return window.__message.send.mock.calls.map(([message]) => message.body.event.type)
}

function flushGestureEvents() {
	return new Promise(resolve => queueMicrotask(resolve))
}

const GESTURE_BINDINGS = {
	bindlongpress: 'onLongPress',
	bindlongtap: 'onLongTap',
	bindtap: 'onTap',
	bindtouchend: 'onTouchEnd',
}

const GestureHost = defineComponent({
	inheritAttrs: false,
	setup() {
		const info = useInfo()
		const elementRef = ref(null)
		useTouchEvents(info, elementRef)
		return () => h('div', { class: 'gesture-host', ref: elementRef })
	},
})

beforeEach(() => {
	window.__message = { invoke: vi.fn(), off: vi.fn(), on: vi.fn(), send: vi.fn() }
	window.__callback = { remove: vi.fn(), store: vi.fn() }
})

afterEach(() => {
	mounted?.app.unmount()
	mounted?.container.remove()
	mounted = null
	vi.useRealTimers()
	vi.restoreAllMocks()
	document.body.innerHTML = ''
})

describe('a node that unmounts mid-sequence stops synthesizing gestures on its own clock', () => {
	it('does not fire the pending longpress on the component path', async () => {
		vi.useFakeTimers()
		const show = ref(true)
		const container = mountApp(() => (show.value ? h(GestureHost, GESTURE_BINDINGS) : h('div')))
		const el = container.querySelector('.gesture-host')

		fireTouch(el, 'touchstart', { touches: [point(10, 10)] })
		show.value = false
		await nextTick()
		vi.advanceTimersByTime(LONG_PRESS_THRESHOLD * 2)

		expect(eventTypes()).not.toContain('longpress')
		expect(eventTypes()).not.toContain('longtap')
	})

	it('does not fire the pending longpress on the native canvas directive path', async () => {
		vi.useFakeTimers()
		const show = ref(true)
		const container = mountApp(() => (show.value
			? withDirectives(
					h('canvas', { 'canvas-id': 'c1', ...GESTURE_BINDINGS }),
					[[resolveDirective('c-event-node'), 'node']],
				)
			: h('div')))
		const el = container.querySelector('canvas')

		fireTouch(el, 'touchstart', { touches: [point(10, 10)] })
		show.value = false
		await nextTick()
		vi.advanceTimersByTime(LONG_PRESS_THRESHOLD * 2)

		expect(eventTypes()).not.toContain('longpress')
		expect(eventTypes()).not.toContain('longtap')
	})

	// 对照组：换 owner 的那条延迟摘除路径上节点仍在树上，长按不能跟着一起停。
	it('keeps the pending longpress when a mid-sequence binding change only swaps the owner', async () => {
		vi.useFakeTimers()
		const catching = ref(false)
		const container = mountApp(() => h(GestureHost, {
			...GESTURE_BINDINGS,
			...(catching.value ? { catchtouchmove: 'onMove' } : {}),
		}))
		const el = container.querySelector('.gesture-host')

		fireTouch(el, 'touchstart', { touches: [point(10, 10)] })
		catching.value = true
		await nextTick()
		vi.advanceTimersByTime(LONG_PRESS_THRESHOLD * 2)

		expect(eventTypes()).toContain('longpress')
	})

	// 真实终态仍要送达：卸载不伪造终态，也不吞掉用户真的抬起手指这一下。
	it('still delivers the terminal touchend of the sequence that was already in flight', async () => {
		vi.useFakeTimers()
		const show = ref(true)
		const container = mountApp(() => (show.value ? h(GestureHost, GESTURE_BINDINGS) : h('div')))
		const el = container.querySelector('.gesture-host')

		fireTouch(el, 'touchstart', { touches: [point(10, 10)] })
		show.value = false
		await nextTick()
		vi.advanceTimersByTime(LONG_PRESS_THRESHOLD * 2)
		fireTouch(el, 'touchend', { touches: [], changedTouches: [point(10, 10)] })
		await flushGestureEvents()

		expect(eventTypes()).toContain('touchend')
	})
})
