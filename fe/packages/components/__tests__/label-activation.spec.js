/** @vitest-environment jsdom */
// label 激活控件的语义：一次交互在路径上的每个节点只产生一次 tap，
// 被激活的控件做自己的动作但不补发自己的 tap，也不波及它的祖先。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, provide, ref } from 'vue'
import Button from '../src/component/button/Button.vue'
import Input from '../src/component/input/Input.vue'
import Label from '../src/component/label/Label.vue'
import Slider from '../src/component/slider/Slider.vue'
import Switch from '../src/component/switch/Switch.vue'
import Textarea from '../src/component/textarea/Textarea.vue'
import View from '../src/component/view/View.vue'

const PATH = '/pages/index/index'

function fire(target, type, props = {}) {
	const event = new Event(type, { bubbles: true, cancelable: true, composed: true })
	Object.assign(event, props)
	target.dispatchEvent(event)
	return event
}

function touchPoint({ identifier = 0, pageX = 10, pageY = 10 } = {}) {
	return { identifier, pageX, pageY, clientX: pageX, clientY: pageY, screenX: pageX, screenY: pageY, force: 1 }
}

function fireTouch(el, type, points) {
	return fire(el, type, { touches: points, changedTouches: points, targetTouches: points })
}

function mount(render) {
	const container = document.createElement('div')
	document.body.append(container)
	const app = createApp({
		setup() {
			provide('bridgeId', 'page-1')
			provide('path', PATH)
			provide(PATH, { id: 'module-1' })
			return render
		},
	})
	app.mount(container)
	return container
}

async function flush() {
	await Promise.resolve()
	await Promise.resolve()
}

// 一次完整的鼠标交互：指针序列合成 tap，浏览器随后补发带 detail 的 click
async function tap(element) {
	const point = { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 10, clientY: 10, pageX: 10, pageY: 10 }
	fire(element, 'pointerdown', point)
	fire(document, 'pointerup', point)
	await flush()
	fire(element, 'click', { ...point, detail: 1 })
	await flush()
}

function sentMethods() {
	return window.__message.send.mock.calls.map(([m]) => m.body.methodName).filter(Boolean)
}

function sentEvents(methodName) {
	return window.__message.send.mock.calls
		.map(([m]) => m.body)
		.filter(body => body.methodName === methodName)
		.map(body => body.event)
}

function countMethod(name) {
	return sentMethods().filter(method => method === name).length
}

beforeEach(() => {
	window.__message = { send: vi.fn(), invoke: vi.fn(), on: vi.fn(), off: vi.fn() }
	window.__callback = { store: vi.fn(), remove: vi.fn() }
	document.body.innerHTML = ''
})

describe('tapping a label with a control inside', () => {
	it('dispatches exactly one tap on the label and one on its ancestor', async () => {
		const container = mount(() => h(View, { bindtap: 'onViewTap' }, {
			default: () => h(Label, { bindtap: 'onLabelTap' }, {
				default: () => [h(Switch, { bindchange: 'onChange' }), h('span', { class: 'text' }, 'text')],
			}),
		}))

		await tap(container.querySelector('.text'))

		expect(countMethod('onLabelTap')).toBe(1)
		expect(countMethod('onViewTap')).toBe(1)
	})

	it('runs the control action without letting the control emit its own tap', async () => {
		const container = mount(() => h(Label, { bindtap: 'onLabelTap' }, {
			default: () => [
				h(Switch, { bindtap: 'onSwitchTap', bindchange: 'onChange' }),
				h('span', { class: 'text' }, 'text'),
			],
		}))

		await tap(container.querySelector('.text'))

		expect(countMethod('onChange')).toBe(1)
		expect(countMethod('onSwitchTap')).toBe(0)
	})

	it('reports the control itself as the activated event target, not the label', async () => {
		// 事件的 id/dataset 取自 currentTarget/target：带成 label 的话，小程序会把
		// 这次 change 当作发生在 label 上。
		const container = mount(() => h(Label, { 'data-name': 'labelA', 'bindtap': 'onLabelTap' }, {
			default: () => [
				h(Switch, { 'id': 'sw-a', 'data-name': 'switchA', 'bindchange': 'onChange' }),
				h('span', { class: 'text' }, 'text'),
			],
		}))

		await tap(container.querySelector('.text'))

		const [change] = sentEvents('onChange')
		expect(change.currentTarget.dataset.name).toBe('switchA')
		expect(change.currentTarget.id).toBe('sw-a')
		expect(change.target.dataset.name).toBe('switchA')
	})

	it('leaves activation to the control itself when the tap lands on the control', async () => {
		const container = mount(() => h(Label, { bindtap: 'onLabelTap' }, {
			default: () => [
				h(Switch, { bindtap: 'onSwitchTap', bindchange: 'onChange' }),
				h('span', { class: 'text' }, 'text'),
			],
		}))

		await tap(container.querySelector('[data-dd-label-target]'))

		expect(countMethod('onChange')).toBe(1)
		expect(countMethod('onSwitchTap')).toBe(1)
		expect(countMethod('onLabelTap')).toBe(1)
	})

	// 守卫看的是"点在任一可激活控件上"，而不是"点在将被激活的那一个上"：微信里 label 内
	// 开关在前、输入框在后时，点输入框本体只让输入框自己响应，开关不被激活。
	it('leaves the first control alone when the tap lands on a later control', async () => {
		const container = mount(() => h(Label, { bindtap: 'onLabelTap' }, {
			default: () => [
				h(Switch, { bindchange: 'onChange' }),
				h(Input, { bindfocus: 'onFocus' }),
			],
		}))

		await tap(container.querySelector('input'))

		expect(countMethod('onChange')).toBe(0)
		expect(countMethod('onLabelTap')).toBe(1)
	})

	it('activates the first control in document order when the label holds several', async () => {
		const container = mount(() => h(Label, {}, {
			default: () => [
				h('span', { class: 'text' }, 'text'),
				h(Switch, { bindchange: 'onChange' }),
				h(Input, { bindfocus: 'onFocus' }),
			],
		}))

		await tap(container.querySelector('.text'))

		expect(countMethod('onChange')).toBe(1)
		expect(document.activeElement).not.toBe(container.querySelector('input'))
	})

	it('focuses a nested input without the browser forwarding a second click into it', async () => {
		const container = mount(() => h(Label, { bindtap: 'onLabelTap' }, {
			default: () => [h(Input, {}), h('span', { class: 'text' }, 'text')],
		}))
		const nativeInput = container.querySelector('input')
		const forwardedClicks = []
		nativeInput.addEventListener('click', () => forwardedClicks.push('click'))

		await tap(container.querySelector('.text'))

		expect(document.activeElement).toBe(nativeInput)
		expect(forwardedClicks).toEqual([])
		expect(countMethod('onLabelTap')).toBe(1)
	})

	// 激活由 activateTarget 显式完成，浏览器随后对 label 的默认激活必须被取消，否则 for/内嵌
	// 指向的原生 labelable 控件会被再切换一次，两次相抵后回到原值。jsdom 不实现 label 的
	// 默认激活，`forwardedClicks` 为空在这里恒真，抓不住这个回归；改判 click 有没有被取消。
	it('cancels the click that would let the browser activate the control a second time', async () => {
		const container = mount(() => h(Label, { bindtap: 'onLabelTap' }, {
			default: () => [h(Input, {}), h('span', { class: 'text' }, 'text')],
		}))

		const point = { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 10, clientY: 10, pageX: 10, pageY: 10 }
		fire(container.querySelector('.text'), 'pointerdown', point)
		fire(document, 'pointerup', point)
		await flush()
		const click = fire(container.querySelector('.text'), 'click', { ...point, detail: 1 })
		await flush()

		expect(click.defaultPrevented).toBe(true)
	})

	// 勾选类控件被激活时不派发自己的 tap，button 派发，而且那次 tap 会冒泡：
	// 微信里点 label 文字，button 一次、label 与外层 view 各两次，
	// 顺序是 button 补发的那次先走完整条链，原始触摸序列的 tap 再走一遍。
	it('lets an activated button emit a tap that bubbles through the label to its ancestors', async () => {
		const container = mount(() => h(View, { bindtap: 'onOuterViewTap' }, {
			default: () => h(Label, { bindtap: 'onLabelTap' }, {
				default: () => [h(Button, { bindtap: 'onButtonTap' }), h('span', { class: 'text' }, 'text')],
			}),
		}))

		await tap(container.querySelector('.text'))

		expect(countMethod('onButtonTap')).toBe(1)
		expect(countMethod('onLabelTap')).toBe(2)
		expect(countMethod('onOuterViewTap')).toBe(2)
		expect(sentMethods()).toEqual([
			'onButtonTap',
			'onLabelTap',
			'onOuterViewTap',
			'onLabelTap',
			'onOuterViewTap',
		])
	})

	// 补发的那次 tap 带着 label 这次触摸的坐标和触摸点，不是一个没有触摸点的合成事件：
	// 微信实测两次 tap 的 x/y 与 touches/changedTouches 数量完全一致。
	it('gives the activated button tap the same touch payload as the label tap', async () => {
		const container = mount(() => h(Label, { bindtap: 'onLabelTap' }, {
			default: () => [h(Button, { bindtap: 'onButtonTap' }), h('span', { class: 'text' }, 'text')],
		}))

		await tap(container.querySelector('.text'))

		const [buttonTap] = sentEvents('onButtonTap')
		const [labelTap] = sentEvents('onLabelTap')
		expect(labelTap.detail.x).toEqual(expect.any(Number))
		expect(labelTap.touches).toHaveLength(1)
		expect(labelTap.changedTouches).toHaveLength(1)
		expect(buttonTap.detail).toEqual(labelTap.detail)
		expect(buttonTap.touches).toEqual(labelTap.touches)
		expect(buttonTap.changedTouches).toEqual(labelTap.changedTouches)
	})

	// disabled 的 button 不做动作，补发的 tap 通道也不能开——否则它自己 no-op、
	// 祖先却照样收到冒泡过来的那一次
	it('does not let a disabled button leak an activation tap into its ancestors', async () => {
		const container = mount(() => h(View, { bindtap: 'onOuterViewTap' }, {
			default: () => h(Label, { bindtap: 'onLabelTap' }, {
				default: () => [
					h(Button, { disabled: true, bindtap: 'onButtonTap' }),
					h('span', { class: 'text' }, 'text'),
				],
			}),
		}))

		await tap(container.querySelector('.text'))

		expect(countMethod('onButtonTap')).toBe(0)
		expect(countMethod('onLabelTap')).toBe(1)
		expect(countMethod('onOuterViewTap')).toBe(1)
	})

	// 补发的 tap 走的是自定义事件，但对使用者来说它就是一次 tap，
	// 中途的 catch:tap 必须能拦住它，否则冒泡通道成了绕过 catch 的后门
	it('lets catchtap on the label block the activated button tap from reaching ancestors', async () => {
		const container = mount(() => h(View, { bindtap: 'onOuterViewTap' }, {
			default: () => h(Label, { catchtap: 'onLabelTap' }, {
				default: () => [h(Button, { bindtap: 'onButtonTap' }), h('span', { class: 'text' }, 'text')],
			}),
		}))

		await tap(container.querySelector('.text'))

		expect(countMethod('onButtonTap')).toBe(1)
		expect(countMethod('onLabelTap')).toBe(2)
		expect(countMethod('onOuterViewTap')).toBe(0)
	})

	// switch 有 checkbox / switch 两种形态，切换时根元素换成另一个节点，
	// 激活入口必须跟着搬家，否则改了 type 之后 label 就再也点不动它
	it('keeps the activation entry on the switch root after its shape changes', async () => {
		const shape = ref('switch')
		const container = mount(() => h(Label, {}, {
			default: () => [
				h(Switch, { type: shape.value, bindchange: 'onChange' }),
				h('span', { class: 'text' }, 'text'),
			],
		}))

		shape.value = 'checkbox'
		await flush()
		await flush()

		await tap(container.querySelector('.text'))

		expect(countMethod('onChange')).toBe(1)
	})
})

// 可激活的控件只有 button、checkbox、input、radio、switch 五种。textarea 和 slider
// 既不会被 label 找上，也不算"点在控件上"——点它们的本体，label 照样激活后面的控件。
describe('controls a label never activates', () => {
	it('skips a textarea and activates the control behind it', async () => {
		const container = mount(() => h(Label, {}, {
			default: () => [
				h(Textarea, { bindfocus: 'onTextareaFocus' }),
				h(Switch, { bindchange: 'onChange' }),
				h('span', { class: 'text' }, 'text'),
			],
		}))

		await tap(container.querySelector('.text'))

		expect(countMethod('onChange')).toBe(1)
		expect(document.activeElement).not.toBe(container.querySelector('textarea'))
	})

	it('still activates the control when the tap lands on the textarea itself', async () => {
		const container = mount(() => h(Label, {}, {
			default: () => [h(Textarea, {}), h(Switch, { bindchange: 'onChange' })],
		}))

		await tap(container.querySelector('textarea'))

		expect(countMethod('onChange')).toBe(1)
	})

	it('skips a slider and activates the control behind it', async () => {
		const container = mount(() => h(Label, {}, {
			default: () => [
				h(Slider, { bindchange: 'onSliderChange' }),
				h(Switch, { bindchange: 'onSwitchChange' }),
				h('span', { class: 'text' }, 'text'),
			],
		}))

		await tap(container.querySelector('.text'))

		expect(countMethod('onSwitchChange')).toBe(1)
		expect(countMethod('onSliderChange')).toBe(0)
	})

	it('still activates the control when the tap lands on the slider itself', async () => {
		const container = mount(() => h(Label, {}, {
			default: () => [
				h(Slider, { bindchange: 'onSliderChange' }),
				h(Switch, { bindchange: 'onSwitchChange' }),
			],
		}))

		await tap(container.querySelector('.dd-slider'))

		expect(countMethod('onSwitchChange')).toBe(1)
	})
})

// 守卫只看被点节点到 label 之间的这一段：label 外面套着的可激活控件不参与判断。
describe('a control wrapping the label from outside', () => {
	it('does not suppress the activation of a control inside the label', async () => {
		const container = mount(() => h(View, { bindtap: 'onViewTap' }, {
			default: () => h(Button, { bindtap: 'onButtonTap' }, {
				default: () => h(Label, { bindtap: 'onLabelTap' }, {
					default: () => [h(Switch, { bindchange: 'onChange' }), h('span', { class: 'text' }, 'text')],
				}),
			}),
		}))

		await tap(container.querySelector('.text'))

		expect(sentMethods()).toEqual(['onChange', 'onLabelTap', 'onButtonTap', 'onViewTap'])
	})
})

describe('a label activating a remote control through for=', () => {
	it('activates the control without dispatching tap on the control or its ancestors', async () => {
		const container = mount(() => h('div', [
			h(Label, { for: 'sw1', bindtap: 'onLabelTap' }, { default: () => h('span', { class: 'text' }, 'text') }),
			h(View, { bindtap: 'onRemoteViewTap' }, {
				default: () => h(Switch, { id: 'sw1', bindtap: 'onSwitchTap', bindchange: 'onChange' }),
			}),
		]))

		await tap(container.querySelector('.text'))

		expect(countMethod('onChange')).toBe(1)
		expect(countMethod('onLabelTap')).toBe(1)
		expect(countMethod('onSwitchTap')).toBe(0)
		expect(countMethod('onRemoteViewTap')).toBe(0)
	})

	// 远程 button 同样派发会冒泡的 tap，波及的是远程按钮自己那条祖先链而不是 label 那条
	it('lets a remote button emit a tap that reaches its own ancestors', async () => {
		const container = mount(() => h('div', [
			h(Label, { for: 'btn1', bindtap: 'onLabelTap' }, { default: () => h('span', { class: 'text' }, 'text') }),
			h(View, { bindtap: 'onRemoteViewTap' }, {
				default: () => h(Button, { id: 'btn1', bindtap: 'onButtonTap' }),
			}),
		]))

		await tap(container.querySelector('.text'))

		expect(sentMethods()).toEqual(['onButtonTap', 'onRemoteViewTap', 'onLabelTap'])
	})

	it('focuses a remote input without leaking a tap into its ancestors', async () => {
		const container = mount(() => h('div', [
			h(Label, { for: 'in1' }, { default: () => h('span', { class: 'text' }, 'text') }),
			h(View, { bindtap: 'onRemoteViewTap' }, { default: () => h(Input, { id: 'in1' }) }),
		]))

		await tap(container.querySelector('.text'))

		expect(document.activeElement).toBe(container.querySelector('input'))
		expect(countMethod('onRemoteViewTap')).toBe(0)
	})
})

describe('a label interaction that produces no tap produces no activation', () => {
	it('does not activate the control when a long press suppresses the tap', async () => {
		vi.useFakeTimers()
		try {
			const container = mount(() => h(Label, { bindlongpress: 'onLongPress' }, {
				default: () => [h(Switch, { bindchange: 'onChange' }), h('span', { class: 'text' }, 'text')],
			}))
			const text = container.querySelector('.text')
			const points = [touchPoint()]

			fireTouch(text, 'touchstart', points)
			vi.advanceTimersByTime(400)
			fireTouch(text, 'touchend', points)
			await flush()

			expect(countMethod('onLongPress')).toBe(1)
			expect(countMethod('onChange')).toBe(0)
		}
		finally {
			vi.useRealTimers()
		}
	})

	it('does not activate the control when the finger moves away and cancels the tap', async () => {
		const container = mount(() => h(Label, { bindcanceltap: 'onCancelTap' }, {
			default: () => [h(Switch, { bindchange: 'onChange' }), h('span', { class: 'text' }, 'text')],
		}))
		const text = container.querySelector('.text')

		fireTouch(text, 'touchstart', [touchPoint({ pageX: 10, pageY: 10 })])
		fireTouch(text, 'touchmove', [touchPoint({ pageX: 90, pageY: 10 })])
		fireTouch(text, 'touchend', [touchPoint({ pageX: 90, pageY: 10 })])
		await flush()

		expect(countMethod('onCancelTap')).toBe(1)
		expect(countMethod('onChange')).toBe(0)
	})
})
