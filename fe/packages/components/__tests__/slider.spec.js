/** @vitest-environment jsdom */

import { createApp, h, nextTick, reactive } from 'vue'
import Slider from '../src/component/slider/Slider.vue'

const mounts = []

function mountComponent(component, props = {}) {
	const host = document.createElement('div')
	document.body.appendChild(host)
	const app = createApp({
		setup() {
			provide('bridgeId', 'bridge-1')
			provide('path', 'page-path')
			provide('page-path', { id: 'module-1' })
			return () => h(component, props)
		},
	})
	app.mount(host)
	const mounted = { app, host }
	mounts.push(mounted)
	return mounted
}

function mockTrackGeometry(host, { left = 0, width = 100 } = {}) {
	const tapArea = host.querySelector('.dd-slider-tap-area')
	tapArea.getBoundingClientRect = () => ({ left, width })
	return tapArea
}

function sentEvents() {
	return window.__message.send.mock.calls.map(([message]) => message.body)
}

function createTouchEvent(type, { touches = [], changedTouches = [] } = {}) {
	const event = new Event(type, { bubbles: true, cancelable: true })
	Object.defineProperties(event, {
		touches: { value: touches },
		changedTouches: { value: changedTouches },
	})
	return event
}

beforeEach(() => {
	window.__message = {
		invoke: vi.fn(),
		off: vi.fn(),
		on: vi.fn(),
		send: vi.fn(),
	}
	window.__callback = {
		remove: vi.fn(),
		store: vi.fn(() => `callback-${Math.random()}`),
	}
	window.ResizeObserver = class {
		disconnect() {}
		observe() {}
	}
})

afterEach(() => {
	while (mounts.length) {
		const { app, host } = mounts.pop()
		app.unmount()
		host.remove()
	}
	vi.unstubAllGlobals()
})

describe('slider wechat alignment', () => {
	it('reports events with the root element as currentTarget so the logic layer can resolve data-sid', async () => {
		const { host } = mountComponent(Slider, {
			id: 'my-slider',
			'data-sid': 'slider-node-1',
			bindchange: 'changeHandler',
		})
		mockTrackGeometry(host)
		await nextTick()

		host.querySelector('.dd-slider-tap-area').dispatchEvent(
			new MouseEvent('click', { bubbles: true, clientX: 50 })
		)

		const [event] = sentEvents()
		expect(event.methodName).toBe('changeHandler')
		// 修复前 currentTarget 是 .dd-slider-tap-area（无 id / 无 sid），逻辑层反查不到节点
		expect(event.event.currentTarget.id).toBe('my-slider')
		expect(event.event.currentTarget.dataset.sid).toBe('slider-node-1')
	})

	it('does not fire change when the value stays the same', async () => {
		const { host } = mountComponent(Slider, {
			bindchange: 'changeHandler',
			min: 0,
			max: 10,
			step: 5,
			value: 5,
		})
		mockTrackGeometry(host)
		await nextTick()

		// 点击 handle 当前位置（50% 处落点 5，与当前值相同），change 不应触发
		host.querySelector('.dd-slider-tap-area').dispatchEvent(
			new MouseEvent('click', { bubbles: true, clientX: 50 })
		)
		await nextTick()
		expect(sentEvents()).toHaveLength(0)

		// 点击新位置（0% 处落点 0），值变化应触发 change
		host.querySelector('.dd-slider-tap-area').dispatchEvent(
			new MouseEvent('click', { bubbles: true, clientX: 0 })
		)
		await nextTick()
		const [event] = sentEvents()
		expect(event.methodName).toBe('changeHandler')
		expect(event.event.detail.value).toBe(0)
	})

	it('does not seek when the tap lands on the value text beside the track', async () => {
		// 手势装在根元素上，数值文本也在根元素里；按落点算值会把落点 clamp 到端点，
		// 表现为点一下数字滑块就跳满格。
		const { host } = mountComponent(Slider, {
			bindchange: 'changeHandler',
			showValue: true,
			min: 0,
			max: 100,
			value: 30,
		})
		mockTrackGeometry(host, { left: 0, width: 100 })
		await nextTick()

		host.querySelector('.dd-slider-value').dispatchEvent(
			new MouseEvent('click', { bubbles: true, clientX: 150 })
		)
		await nextTick()

		expect(sentEvents()).toHaveLength(0)
	})

	it('clamps blockSize into the wechat range of 12 - 28', async () => {
		const { host } = mountComponent(Slider, {
			blockSize: 40,
		})
		await nextTick()
		const thumb = host.querySelector('.dd-slider-thumb')
		expect(thumb.style.width).toBe('28px')
		expect(thumb.style.height).toBe('28px')
	})

	it('rounds step values to the largest decimal precision without float tails', async () => {
		const { host } = mountComponent(Slider, {
			min: 0,
			max: 1,
			step: 0.1,
			value: 0.3,
			showValue: true,
		})
		await nextTick()
		expect(host.querySelector('.dd-slider-value p').textContent.trim()).toBe('0.3')
	})

	it('clamps a non-divisible step result to max at the right edge', async () => {
		const { host } = mountComponent(Slider, {
			bindchange: 'changeHandler',
			min: 0,
			max: 10,
			step: 6,
			value: 0,
			showValue: true,
		})
		mockTrackGeometry(host)
		await nextTick()

		host.querySelector('.dd-slider-tap-area').dispatchEvent(
			new MouseEvent('click', { bubbles: true, clientX: 100 })
		)
		await nextTick()

		const [event] = sentEvents()
		expect(event.event.detail.value).toBe(10)
		expect(host.querySelector('.dd-slider-value p').textContent.trim()).toBe('10')
		expect(host.querySelector('.dd-slider').getAttribute('aria-valuenow')).toBe('10')
		expect(host.querySelector('.dd-slider-thumb').style.left).toBe('100%')
	})

	it('keeps scientific-notation step precision when moving the slider', async () => {
		const { host } = mountComponent(Slider, {
			bindchange: 'changeHandler',
			min: 0,
			max: 1.2e-6,
			step: 1.2e-7,
			value: 0,
			showValue: true,
		})
		mockTrackGeometry(host)
		await nextTick()

		host.querySelector('.dd-slider-tap-area').dispatchEvent(
			new MouseEvent('click', { bubbles: true, clientX: 10 })
		)
		await nextTick()

		const [event] = sentEvents()
		expect(event.event.detail.value).toBe(1.2e-7)
		expect(host.querySelector('.dd-slider-value p').textContent.trim()).toBe('1.2e-7')
	})

	it('reserves value text width for the decimal point', async () => {
		const { host } = mountComponent(Slider, {
			min: 0,
			max: 1,
			step: 0.1,
			value: 0.3,
			showValue: true,
		})
		await nextTick()

		const value = host.querySelector('.dd-slider-value p')
		expect(value.textContent.trim()).toBe('0.3')
		expect(value.style.width).toBe('3ch')
	})

	it('reserves value text width for a negative min wider than max', async () => {
		const { host } = mountComponent(Slider, {
			min: -100,
			max: 1,
			step: 1,
			value: -100,
			showValue: true,
		})
		await nextTick()

		const value = host.querySelector('.dd-slider-value p')
		expect(value.textContent.trim()).toBe('-100')
		expect(value.style.width).toBe('4ch')
	})

	it('falls back from backgroundColor to color when backgroundColor is not explicit', async () => {
		const { host } = mountComponent(Slider, {
			color: '#ff0000',
		})
		await nextTick()
		// 未显式传 backgroundColor：props 默认值不应遮蔽显式传入的 color
		// （jsdom 把颜色序列化为 rgb 格式）
		expect(host.querySelector('.dd-slider-handle-wrapper').style.backgroundColor).toBe('rgb(255, 0, 0)')
	})

	it('honours explicit backgroundColor over color', async () => {
		const { host } = mountComponent(Slider, {
			color: '#ff0000',
			backgroundColor: '#00ff00',
		})
		await nextTick()
		expect(host.querySelector('.dd-slider-handle-wrapper').style.backgroundColor).toBe('rgb(0, 255, 0)')
	})

	it('syncs display value when the value prop changes externally', async () => {
		const props = reactive({
			value: 10,
			showValue: true,
		})
		const host = document.createElement('div')
		document.body.appendChild(host)
		const app = createApp({
			setup() {
				provide('bridgeId', 'bridge-1')
				provide('path', 'page-path')
				provide('page-path', { id: 'module-1' })
				return () => h(Slider, props)
			},
		})
		app.mount(host)
		mounts.push({ app, host })
		await nextTick()

		props.value = 60
		await nextTick()
		expect(host.querySelector('.dd-slider-value p').textContent.trim()).toBe('60')
	})

	it('ignores interaction while disabled', async () => {
		const { host } = mountComponent(Slider, {
			disabled: true,
			bindchange: 'changeHandler',
		})
		mockTrackGeometry(host)
		await nextTick()

		host.querySelector('.dd-slider-tap-area').dispatchEvent(
			new MouseEvent('click', { bubbles: true, clientX: 50 })
		)
		expect(sentEvents()).toHaveLength(0)
	})

	it('fires changing while dragging and change on release, both with root currentTarget', async () => {
		const { host } = mountComponent(Slider, {
			id: 'drag-slider',
			bindchanging: 'changingHandler',
			bindchange: 'changeHandler',
			min: 0,
			max: 100,
			step: 1,
		})
		mockTrackGeometry(host)
		await nextTick()

		host.querySelector('.dd-slider-handle').dispatchEvent(
			new MouseEvent('mousedown', { bubbles: true, clientX: 0 })
		)
		window.dispatchEvent(new MouseEvent('mousemove', { clientX: 75 }))
		window.dispatchEvent(new MouseEvent('mouseup', { clientX: 75 }))

		const events = sentEvents()
		expect(events.map(e => e.methodName)).toEqual(['changingHandler', 'changeHandler'])
		expect(events[0].event.detail.value).toBe(75)
		expect(events[1].event.detail.value).toBe(75)
		expect(events[1].event.currentTarget.id).toBe('drag-slider')
	})

	// 真实鼠标序列里 pointerup 早于 mouseup，合成 tap 排在两者之间的微任务上。tap 只是拖动的
	// 观察者，结算 change 的所有权始终在 endDrag 手里；tap 提前把拖动状态清掉会让 change 消失。
	it('fires change after a short mouse drag even though the synthesized tap lands before mouseup', async () => {
		const { host } = mountComponent(Slider, {
			id: 'short-drag-slider',
			bindchange: 'changeHandler',
			bindtap: 'tapHandler',
			min: 0,
			max: 100,
			step: 1,
		})
		mockTrackGeometry(host)
		await nextTick()

		const handle = host.querySelector('.dd-slider-handle')
		handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, pointerType: 'mouse', button: 0, clientX: 0 }))
		handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 0 }))
		// 位移小于手势层的 moveThreshold，tap 不会被移动取消，但值已经变了
		window.dispatchEvent(new MouseEvent('mousemove', { clientX: 8 }))
		document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, pointerType: 'mouse', button: 0, clientX: 8 }))
		await new Promise(resolve => queueMicrotask(resolve))
		window.dispatchEvent(new MouseEvent('mouseup', { clientX: 8 }))

		const changes = sentEvents().filter(e => e.methodName === 'changeHandler')
		expect(changes).toHaveLength(1)
		expect(changes[0].event.detail.value).toBe(8)
	})

	it('uses changedTouches to calculate the final value before firing change', async () => {
		const { host } = mountComponent(Slider, {
			bindchanging: 'changingHandler',
			bindchange: 'changeHandler',
			min: 0,
			max: 100,
			step: 1,
		})
		mockTrackGeometry(host)
		await nextTick()

		host.querySelector('.dd-slider-handle').dispatchEvent(
			createTouchEvent('touchstart', { touches: [{ clientX: 0 }] })
		)
		window.dispatchEvent(createTouchEvent('touchmove', { touches: [{ clientX: 30 }] }))
		window.dispatchEvent(createTouchEvent('touchend', {
			touches: [],
			changedTouches: [{ clientX: 75 }],
		}))

		const events = sentEvents()
		expect(events.map(event => event.methodName)).toEqual(['changingHandler', 'changeHandler'])
		expect(events.map(event => event.event.detail.value)).toEqual([30, 75])
	})

	it('fires change on touchcancel when the final value differs from the drag start', async () => {
		const { host } = mountComponent(Slider, {
			bindchanging: 'changingHandler',
			bindchange: 'changeHandler',
			min: 0,
			max: 100,
			step: 1,
		})
		mockTrackGeometry(host)
		await nextTick()

		host.querySelector('.dd-slider-handle').dispatchEvent(
			createTouchEvent('touchstart', { touches: [{ clientX: 0 }] })
		)
		window.dispatchEvent(createTouchEvent('touchmove', { touches: [{ clientX: 30 }] }))
		window.dispatchEvent(createTouchEvent('touchcancel', {
			touches: [],
			changedTouches: [{ clientX: 75 }],
		}))

		const events = sentEvents()
		expect(events.map(event => event.methodName)).toEqual(['changingHandler', 'changeHandler'])
		expect(events.map(event => event.event.detail.value)).toEqual([30, 75])
	})

	it('does not fire change when the final touch returns to the drag start value', async () => {
		const { host } = mountComponent(Slider, {
			bindchanging: 'changingHandler',
			bindchange: 'changeHandler',
			min: 0,
			max: 100,
			step: 1,
		})
		mockTrackGeometry(host)
		await nextTick()

		host.querySelector('.dd-slider-handle').dispatchEvent(
			createTouchEvent('touchstart', { touches: [{ clientX: 0 }] })
		)
		window.dispatchEvent(createTouchEvent('touchmove', { touches: [{ clientX: 30 }] }))
		window.dispatchEvent(createTouchEvent('touchend', {
			touches: [],
			changedTouches: [{ clientX: 0 }],
		}))

		const events = sentEvents()
		expect(events.map(event => event.methodName)).toEqual(['changingHandler'])
		expect(events[0].event.detail.value).toBe(30)
	})

	it('does not fire change when a drag ends where it started', async () => {
		const { host } = mountComponent(Slider, {
			bindchange: 'changeHandler',
			min: 0,
			max: 100,
			step: 1,
		})
		mockTrackGeometry(host)
		await nextTick()

		host.querySelector('.dd-slider-handle').dispatchEvent(
			new MouseEvent('mousedown', { bubbles: true, clientX: 0 })
		)
		window.dispatchEvent(new MouseEvent('mousemove', { clientX: 30 }))
		window.dispatchEvent(new MouseEvent('mousemove', { clientX: 0 }))
		window.dispatchEvent(new MouseEvent('mouseup', { clientX: 0 }))

		// 拖动回起点：值回到初始 0，change 不应触发
		expect(sentEvents()).toHaveLength(0)
	})
})
