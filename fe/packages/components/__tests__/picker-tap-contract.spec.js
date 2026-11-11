/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, provide } from 'vue'
import Picker from '../src/component/picker/Picker.vue'

let app, host

function fire(target, type, props = {}) {
	const event = new Event(type, { bubbles: true, cancelable: true })
	Object.assign(event, props)
	target.dispatchEvent(event)
	return event
}

async function flush() {
	await Promise.resolve()
	await nextTick()
}

async function touch(target, { moved = false, cancelled = false } = {}) {
	const point = { identifier: 1, clientX: 30, clientY: 40, pageX: 30, pageY: 40 }
	fire(target, 'touchstart', { touches: [point], changedTouches: [point] })
	if (moved) {
		point.clientY = point.pageY = 80
		fire(target, 'touchmove', { touches: [point], changedTouches: [point] })
	}
	fire(target, cancelled ? 'touchcancel' : 'touchend', { touches: [], changedTouches: [point] })
	await flush()
}

async function mouse(target) {
	const point = { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 30, clientY: 40, pageX: 30, pageY: 40 }
	fire(target, 'pointerdown', point)
	fire(document, 'pointerup', point)
	await flush()
}

function compatibilityClick(target) {
	for (const type of ['mousedown', 'mouseup', 'click']) fire(target, type, { detail: 1 })
}

function mount(props = {}) {
	host = document.createElement('div')
	document.body.append(host)
	app = createApp({
		setup() {
			provide('bridgeId', 'picker-page')
			provide('path', 'index')
			provide('index', { id: 'page-module' })
			return () => h(Picker, {
				range: ['A', 'B', 'C'], bindtap: 'onTap', bindcancel: 'onCancel', bindchange: 'onChange', ...props,
			}, { default: () => h('span', { class: 'trigger' }, '选择') })
		},
	})
	app.mount(host)
	return host.querySelector('.trigger')
}

function sent(method) {
	return window.__message.send.mock.calls.map(([message]) => message.body).filter(body => body.methodName === method)
}

beforeEach(() => {
	window.__message = { send: vi.fn(), invoke: vi.fn(), on: vi.fn(), off: vi.fn() }
})

afterEach(() => {
	app?.unmount()
	document.body.innerHTML = ''
	vi.useRealTimers()
})

describe('picker popup touch boundary', () => {
	for (const selector of ['.dd-picker-overlay', '.dd-picker-cancel', '.dd-picker-confirm']) {
		it(`stays open when the opening touch is followed by a retargeted click on ${selector}`, async () => {
			await touch(mount())
			expect(host.querySelector('.dd-picker-overlay')).not.toBeNull()
			compatibilityClick(host.querySelector(selector))
			await flush()
			expect(host.querySelector('.dd-picker-overlay')).not.toBeNull()
			expect(sent('onTap')).toHaveLength(1)
			expect(sent('onCancel')).toHaveLength(0)
			expect(sent('onChange')).toHaveLength(0)
		})
	}

	for (const [selector, method] of [
		['.dd-picker-overlay', 'onCancel'], ['.dd-picker-cancel', 'onCancel'], ['.dd-picker-confirm', 'onChange'],
	]) {
		it(`handles a separate tap on ${selector} once, including its following compatibility click`, async () => {
			const trigger = mount()
			await touch(trigger)
			await touch(host.querySelector(selector))
			expect(host.querySelector('.dd-picker-overlay')).toBeNull()
			// The close removed the overlay; the browser can retarget its click to the trigger underneath.
			compatibilityClick(trigger)
			await flush()
			expect(host.querySelector('.dd-picker-overlay')).toBeNull()
			expect(sent(method)).toHaveLength(1)
			expect(sent('onTap')).toHaveLength(1)
		})
	}

	it('keeps a column drag and taps inside the panel from cancelling the picker', async () => {
		await touch(mount())
		await touch(host.querySelector('.dd-picker-column-content'), { moved: true })
		await touch(host.querySelector('.dd-picker-title'))
		expect(host.querySelector('.dd-picker-overlay')).not.toBeNull()
		expect(sent('onCancel')).toHaveLength(0)
		expect(sent('onChange')).toHaveLength(0)
	})

	it('keeps dragged and cancelled gestures from opening or dismissing the picker', async () => {
		const trigger = mount()
		await touch(trigger, { moved: true })
		await touch(trigger, { cancelled: true })
		expect(host.querySelector('.dd-picker-overlay')).toBeNull()
		await touch(trigger)
		await touch(host.querySelector('.dd-picker-overlay'), { moved: true })
		await touch(host.querySelector('.dd-picker-cancel'), { cancelled: true })
		expect(host.querySelector('.dd-picker-overlay')).not.toBeNull()
		expect(sent('onCancel')).toHaveLength(0)
	})

	it('opens with a mouse and ignores the retargeted opening click', async () => {
		await mouse(mount())
		compatibilityClick(host.querySelector('.dd-picker-overlay'))
		await flush()
		expect(host.querySelector('.dd-picker-overlay')).not.toBeNull()
		await mouse(host.querySelector('.dd-picker-cancel'))
		expect(sent('onCancel')).toHaveLength(1)
		expect(host.querySelector('.dd-picker-overlay')).toBeNull()
	})

	it('supports programmatic or accessibility clicks without a pointer sequence', async () => {
		mount().click()
		await flush()
		host.querySelector('.dd-picker-confirm').click()
		await flush()
		expect(sent('onChange')).toHaveLength(1)
		expect(sent('onChange')[0].event.detail.value).toBe(0)
		expect(host.querySelector('.dd-picker-overlay')).toBeNull()
	})

	for (const mode of ['selector', 'multiSelector', 'time', 'date']) {
		it(`opens ${mode} on the first short tap`, async () => {
			const range = mode === 'multiSelector' ? [['A', 'B'], ['C', 'D']] : ['A', 'B']
			await touch(mount({ mode, range }))
			expect(host.querySelector('.dd-picker-overlay')).not.toBeNull()
		})
	}

	it('does not open a disabled picker', async () => {
		await touch(mount({ disabled: true }))
		expect(host.querySelector('.dd-picker-overlay')).toBeNull()
		expect(sent('onChange')).toHaveLength(0)
	})

	it('detaches old popup actions after closing and unmounting', async () => {
		const trigger = mount()
		for (let count = 0; count < 3; count++) {
			await touch(trigger)
			const confirm = host.querySelector('.dd-picker-confirm')
			await touch(confirm)
			await touch(confirm)
			expect(sent('onChange')).toHaveLength(count + 1)
		}
		await touch(trigger)
		const confirm = host.querySelector('.dd-picker-confirm')
		app.unmount()
		app = null
		await touch(confirm)
		expect(sent('onChange')).toHaveLength(3)
	})
})
