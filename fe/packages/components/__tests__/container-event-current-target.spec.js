/** @vitest-environment jsdom */
// 容器组件用子项的那次事件派发自己的事件：radio-group / checkbox-group 的 change、
// form 的 submit / reset、picker-view 的 change 都绑在容器上，所以事件里的 currentTarget
// 必须是容器自己——小程序侧靠 currentTarget.dataset / id 认出是哪个容器变了。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, provide, ref } from 'vue'
import Button from '../src/component/button/Button.vue'
import Checkbox from '../src/component/checkbox/Checkbox.vue'
import CheckboxGroup from '../src/component/checkbox-group/CheckboxGroup.vue'
import Form from '../src/component/form/Form.vue'
import Input from '../src/component/input/Input.vue'
import Label from '../src/component/label/Label.vue'
import PickerView from '../src/component/picker-view/PickerView.vue'
import PickerViewColumn from '../src/component/picker-view-column/PickerViewColumn.vue'
import Radio from '../src/component/radio/Radio.vue'
import RadioGroup from '../src/component/radio-group/RadioGroup.vue'

const PATH = '/pages/index/index'

function fire(target, type, props = {}) {
	const event = new Event(type, { bubbles: true, cancelable: true, composed: true })
	Object.assign(event, props)
	target.dispatchEvent(event)
	return event
}

function mount(render) {
	const container = document.createElement('div')
	document.body.append(container)
	createApp({
		setup() {
			provide('bridgeId', 'page-1')
			provide('path', PATH)
			provide(PATH, { id: 'module-1' })
			return render
		},
	}).mount(container)
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

function sentEvent(methodName) {
	const bodies = window.__message.send.mock.calls
		.map(([m]) => m.body)
		.filter(body => body.methodName === methodName)
	expect(bodies).toHaveLength(1)
	return bodies[0].event
}

beforeEach(() => {
	window.__message = { send: vi.fn(), invoke: vi.fn(), on: vi.fn(), off: vi.fn() }
	window.__callback = { store: vi.fn(), remove: vi.fn() }
	document.body.innerHTML = ''
})

describe('radio-group change', () => {
	it('reports the group as currentTarget when the radio itself is tapped', async () => {
		const container = mount(() => h(RadioGroup, { 'id': 'grp', 'bindchange': 'onChange', 'data-name': 'group' }, {
			default: () => h(Radio, { 'value': 'r1', 'data-name': 'radio' }),
		}))

		await tap(container.querySelector('.dd-radio'))

		const event = sentEvent('onChange')
		expect(event.currentTarget.dataset.name).toBe('group')
		expect(event.currentTarget.id).toBe('grp')
		expect(event.detail.value).toBe('r1')
	})

	it('reports the group as currentTarget when a label activates the radio', async () => {
		const container = mount(() => h(RadioGroup, { 'bindchange': 'onChange', 'data-name': 'group' }, {
			default: () => h(Label, {}, {
				default: () => [h(Radio, { 'value': 'r1', 'data-name': 'radio' }), h('span', { class: 'text' }, 'text')],
			}),
		}))

		await tap(container.querySelector('.text'))

		expect(sentEvent('onChange').currentTarget.dataset.name).toBe('group')
	})
})

describe('form submit and reset', () => {
	function mountForm() {
		return mount(() => h(Form, { 'id': 'frm', 'bindsubmit': 'onSubmit', 'bindreset': 'onReset', 'data-name': 'form' }, {
			default: () => [
				h(Input, { name: 'field', value: 'x1' }),
				h(Button, { 'form-type': 'submit', 'data-name': 'submitButton' }),
				h(Button, { 'form-type': 'reset', 'data-name': 'resetButton' }),
			],
		}))
	}

	it('reports the form as currentTarget when a submit button is tapped', async () => {
		const container = mountForm()

		await tap(container.querySelectorAll('.dd-button')[0])

		const event = sentEvent('onSubmit')
		expect(event.currentTarget.dataset.name).toBe('form')
		expect(event.currentTarget.id).toBe('frm')
		expect(event.detail.value).toEqual({ field: 'x1' })
	})

	it('reports the form as currentTarget when a reset button is tapped', async () => {
		const container = mountForm()

		await tap(container.querySelectorAll('.dd-button')[1])

		expect(sentEvent('onReset').currentTarget.dataset.name).toBe('form')
	})

	// 触发 submit 不代替按钮自己的 tap：官方两件事都发，顺序是 tap 在前
	it('still emits the button tap alongside the submit', async () => {
		const container = mount(() => h(Form, { bindsubmit: 'onSubmit' }, {
			default: () => h(Button, { 'form-type': 'submit', 'bindtap': 'onButtonTap' }),
		}))

		await tap(container.querySelector('.dd-button'))

		expect(window.__message.send.mock.calls.map(([m]) => m.body.methodName))
			.toEqual(['onButtonTap', 'onSubmit'])
	})
})

describe('picker-view change', () => {
	// 列内部转发的是原生 DOM 事件，它的 currentTarget 停在列的内容节点上
	async function pickItem(item) {
		const point = { button: 0, clientX: 10, clientY: 10, pageX: 10, pageY: 10 }
		fire(item, 'mousedown', point)
		fire(item, 'mouseup', point)
		await flush()
	}

	it('reports the picker-view as currentTarget when a column value changes', async () => {
		const container = mount(() => h(PickerView, {
			'id': 'pv',
			'value': [0],
			'immediate-change': true,
			'bindchange': 'onChange',
			'data-name': 'picker',
		}, {
			default: () => h(PickerViewColumn, {}, {
				default: () => [h('div', '一'), h('div', '二'), h('div', '三')],
			}),
		}))
		await flush()

		await pickItem(container.querySelectorAll('.dd-picker__content > *')[1])

		const event = sentEvent('onChange')
		expect(event.currentTarget.dataset.name).toBe('picker')
		expect(event.currentTarget.id).toBe('pv')
		expect(event.detail.value).toEqual([1])
	})
})

// change 属于用户那一次滚动选择。滚动结束靠 transitionend 结算，而页面改 value
// 也会让列滚一次，那次不能算成用户选的——否则页面每复位一次就收到一条没人操作过的
// change，而且同一次拖动会先在拖动结束、再在 transitionend 各结算一遍。
describe('picker-view change belongs to the user drag that caused it', () => {
	function changeCalls() {
		return window.__message.send.mock.calls.filter(([m]) => m.body.methodName === 'onChange')
	}

	it('fires once per drag and not at all when the page moves the column', async () => {
		const value = ref([0])
		const container = mount(() => h(PickerView, { 'value': value.value, 'bindchange': 'onChange' }, {
			default: () => h(PickerViewColumn, {}, {
				default: () => [h('div', '一'), h('div', '二'), h('div', '三')],
			}),
		}))
		await flush()
		const content = container.querySelector('.dd-picker__content')
		const settleScroll = () => content.dispatchEvent(new Event('transitionend'))

		fire(content, 'mousedown', { button: 0, clientX: 10, clientY: 10 })
		fire(container.querySelectorAll('.dd-picker__content > *')[1], 'mouseup', { button: 0, clientX: 10, clientY: 10 })
		await flush()
		settleScroll()
		await flush()

		expect(changeCalls()).toHaveLength(1)
		expect(sentEvent('onChange').detail.value).toEqual([1])

		value.value = [2]
		await flush()
		settleScroll()
		await flush()

		expect(changeCalls()).toHaveLength(1)
	})

	it('settles the previous drag when a new one interrupts its scroll animation', async () => {
		const container = mount(() => h(PickerView, { 'value': [0], 'bindchange': 'onChange' }, {
			default: () => h(PickerViewColumn, {}, {
				default: () => [h('div', '一'), h('div', '二'), h('div', '三')],
			}),
		}))
		await flush()
		const content = container.querySelector('.dd-picker__content')
		const items = container.querySelectorAll('.dd-picker__content > *')

		// 第一次拖动选到「二」，滚动动画还没结束就又按了下去：那次 transition 被取消，
		// 它的 transitionend 永不到来，第一条 change 不能因此丢掉。
		fire(content, 'mousedown', { button: 0, clientX: 10, clientY: 10 })
		fire(items[1], 'mouseup', { button: 0, clientX: 10, clientY: 10 })
		await flush()
		fire(content, 'mousedown', { button: 0, clientX: 10, clientY: 10 })
		await flush()

		expect(changeCalls()).toHaveLength(1)
		expect(sentEvent('onChange').detail.value).toEqual([1])
	})
})

describe('checkbox-group change', () => {
	it('reports the group as currentTarget when the checkbox itself is tapped', async () => {
		const container = mount(() => h(CheckboxGroup, { 'id': 'grp', 'bindchange': 'onChange', 'data-name': 'group' }, {
			default: () => h(Checkbox, { 'value': 'c1', 'data-name': 'checkbox' }),
		}))

		await tap(container.querySelector('.dd-checkbox'))

		const event = sentEvent('onChange')
		expect(event.currentTarget.dataset.name).toBe('group')
		expect(event.currentTarget.id).toBe('grp')
		expect(event.detail.value).toEqual(['c1'])
	})

	it('reports the group as currentTarget when a label activates the checkbox', async () => {
		const container = mount(() => h(CheckboxGroup, { 'bindchange': 'onChange', 'data-name': 'group' }, {
			default: () => h(Label, {}, {
				default: () => [h(Checkbox, { 'value': 'c1', 'data-name': 'checkbox' }), h('span', { class: 'text' }, 'text')],
			}),
		}))

		await tap(container.querySelector('.text'))

		expect(sentEvent('onChange').currentTarget.dataset.name).toBe('group')
	})
})
