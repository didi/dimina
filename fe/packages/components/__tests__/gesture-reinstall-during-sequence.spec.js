/** @vitest-environment jsdom */

// bind/catch 变化必须重装监听器（passive 只能在注册时决定），但重装会清掉活动序列、长按计时器和
// tap 状态。处理函数在 touchstart 里改绑定是合法写法，所以重装要等这次触摸自己收口。
// 组件路径（useTouchEvents）和原生 canvas 指令路径（c-event-node）各有一套安装逻辑，都要覆盖。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, provide, ref, resolveDirective, withDirectives } from 'vue'
import { Components } from '../index.js'
import { useInfo } from '../src/common/events.js'
import { useTouchEvents } from '../src/common/useTouchEvents.js'

const BRIDGE_ID = 'bridge-1'
const PATH = '/pages/index/index'
const MODULE_ID = 'module-1'

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

// 重装的可观测信号：手势 owner 在元素上重新注册一遍 touchstart。
function touchStartRegistrations(el, spy) {
	return spy.mock.calls.filter((call, index) => spy.mock.contexts[index] === el && call[0] === 'touchstart').length
}

function flushGestureEvents() {
	return new Promise(resolve => queueMicrotask(resolve))
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
	vi.restoreAllMocks()
	document.body.innerHTML = ''
})

describe('turning on a catch binding mid-sequence does not swallow the sequence in flight', () => {
	it('still emits tap on the component path, and only reinstalls after touchend', async () => {
		const catching = ref(false)
		const listenerSpy = vi.spyOn(Element.prototype, 'addEventListener')
		const container = mountApp(() => h(GestureHost, {
			bindtap: 'onTap',
			bindtouchstart: 'onTouchStart',
			...(catching.value ? { catchtouchmove: 'onMove' } : {}),
		}))
		const el = container.querySelector('.gesture-host')
		expect(touchStartRegistrations(el, listenerSpy)).toBe(1)

		fireTouch(el, 'touchstart', { touches: [point(10, 10)] })
		catching.value = true
		await nextTick()

		expect(touchStartRegistrations(el, listenerSpy)).toBe(1)

		fireTouch(el, 'touchend', { touches: [], changedTouches: [point(10, 10)] })
		await flushGestureEvents()

		expect(eventTypes()).toContain('tap')
		expect(touchStartRegistrations(el, listenerSpy)).toBe(2)
	})

	it('still emits tap on the native canvas directive path, and only reinstalls after touchend', async () => {
		const catching = ref(false)
		const listenerSpy = vi.spyOn(Element.prototype, 'addEventListener')
		const container = mountApp(() => withDirectives(
			h('canvas', {
				'bindtap': 'onTap',
				'bindtouchstart': 'onTouchStart',
				'canvas-id': 'c1',
				...(catching.value ? { catchtouchmove: 'onMove' } : {}),
			}),
			[[resolveDirective('c-event-node'), 'node']],
		))
		const el = container.querySelector('canvas')
		expect(touchStartRegistrations(el, listenerSpy)).toBe(1)

		fireTouch(el, 'touchstart', { touches: [point(10, 10)] })
		catching.value = true
		await nextTick()

		expect(touchStartRegistrations(el, listenerSpy)).toBe(1)

		fireTouch(el, 'touchend', { touches: [], changedTouches: [point(10, 10)] })
		await flushGestureEvents()

		expect(eventTypes()).toContain('tap')
		expect(touchStartRegistrations(el, listenerSpy)).toBe(2)
	})

	it('reinstalls immediately when the binding changes between sequences', async () => {
		const catching = ref(false)
		const listenerSpy = vi.spyOn(Element.prototype, 'addEventListener')
		const container = mountApp(() => h(GestureHost, {
			bindtap: 'onTap',
			...(catching.value ? { catchtouchmove: 'onMove' } : {}),
		}))
		const el = container.querySelector('.gesture-host')

		catching.value = true
		await nextTick()

		expect(touchStartRegistrations(el, listenerSpy)).toBe(2)
	})

	// 换 owner 排队期间又改了一次绑定时，收口后要按最后一次的绑定安装，不能装成中途那一版。
	it('installs the latest bindings when they change twice during one sequence', async () => {
		const catching = ref(false)
		const container = mountApp(() => h(GestureHost, {
			bindtap: 'onTap',
			...(catching.value ? { catchtouchmove: 'onMove' } : {}),
		}))
		const el = container.querySelector('.gesture-host')
		Object.defineProperties(el, {
			clientHeight: { configurable: true, value: 100 },
			scrollHeight: { configurable: true, value: 300 },
			scrollTop: { configurable: true, value: 50, writable: true },
		})

		fireTouch(el, 'touchstart', { touches: [point(0, 100)] })
		catching.value = true
		await nextTick()
		catching.value = false
		await nextTick()
		fireTouch(el, 'touchend', { touches: [], changedTouches: [point(0, 100)] })
		await flushGestureEvents()

		fireTouch(el, 'touchstart', { touches: [point(0, 100)] })
		const move = fireTouch(el, 'touchmove', { touches: [point(0, 50)] })

		expect(move.defaultPrevented).toBe(false)
	})
})
