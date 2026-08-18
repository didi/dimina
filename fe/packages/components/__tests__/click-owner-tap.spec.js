/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, provide, ref } from 'vue'
import Button from '../src/component/button/Button.vue'
import Checkbox from '../src/component/checkbox/Checkbox.vue'
import Label from '../src/component/label/Label.vue'
import MovableArea from '../src/component/movable-area/MovableArea.vue'
import Navigator from '../src/component/navigator/Navigator.vue'
import Picker from '../src/component/picker/Picker.vue'
import Radio from '../src/component/radio/Radio.vue'
import Slider from '../src/component/slider/Slider.vue'
import Switch from '../src/component/switch/Switch.vue'
import View from '../src/component/view/View.vue'

const PATH = '/pages/index/index'

function fire(target, type, props = {}) {
	const event = new Event(type, { bubbles: true, cancelable: true, composed: true })
	Object.assign(event, props)
	target.dispatchEvent(event)
	return event
}

function mountNested(Child, childProps = {}) {
	const container = document.createElement('div')
	document.body.append(container)
	const app = createApp({
		setup() {
			provide('bridgeId', 'page-1')
			provide('path', PATH)
			provide(PATH, { id: 'module-1' })
			return () => h(View, { bindtap: 'onOuterTap' }, {
				default: () => h(Child, { ...childProps, catchtap: 'onInnerTap', class: 'inner-owner' }),
			})
		},
	})
	app.mount(container)
	return { app, element: container.querySelector('.inner-owner') }
}

async function performPointerTap(element) {
	const point = {
		pointerId: 1,
		pointerType: 'mouse',
		button: 0,
		clientX: 10,
		clientY: 10,
		pageX: 10,
		pageY: 10,
		screenX: 10,
		screenY: 10,
		pressure: 0.5,
	}
	fire(element, 'pointerdown', point)
	fire(document, 'pointerup', point)
	await Promise.resolve()
	fire(element, 'click', { ...point, detail: 1 })
}

beforeEach(() => {
	window.__message = { send: vi.fn(), invoke: vi.fn(), on: vi.fn(), off: vi.fn() }
	window.__callback = { store: vi.fn(), remove: vi.fn() }
})

afterEach(() => {
	document.body.innerHTML = ''
})

describe('components with built-in tap actions share the gesture owner', () => {
	it.each([
		['button', Button],
		['checkbox', Checkbox],
		['label', Label],
		['radio', Radio],
		['switch', Switch],
		['movable-area', MovableArea],
		['navigator', Navigator, { url: '/pages/next/index' }],
		['picker', Picker],
		['slider', Slider],
	])('lets %s catchtap block an ancestor tap during the same pointer sequence', async (_name, Child, childProps) => {
		const { app, element } = mountNested(Child, childProps)
		try {
			await performPointerTap(element)
			const methods = window.__message.send.mock.calls
				.map(([message]) => message.body.methodName)
				.filter(Boolean)
			expect(methods).toEqual(['onInnerTap'])
		}
		finally {
			app.unmount()
		}
	})

	it('follows the switch root to the new node when type swaps it', async () => {
		// checkbox / switch 两种形态是两个不同的根节点，手势留在被移除的那个上就等于
		// 控件失去全部交互。
		const container = document.createElement('div')
		document.body.append(container)
		const type = ref('checkbox')
		const app = createApp({
			setup() {
				provide('bridgeId', 'page-1')
				provide('path', PATH)
				provide(PATH, { id: 'module-1' })
				return () => h(Switch, { type: type.value, bindchange: 'onChange' })
			},
		})
		app.mount(container)
		try {
			type.value = 'switch'
			await nextTick()
			await performPointerTap(container.querySelector('.dd-switch-input'))
			const methods = window.__message.send.mock.calls
				.map(([message]) => message.body.methodName)
				.filter(Boolean)
			expect(methods).toContain('onChange')
		}
		finally {
			app.unmount()
		}
	})
})
