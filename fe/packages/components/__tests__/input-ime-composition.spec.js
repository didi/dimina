/** @vitest-environment jsdom */

import { createApp, h, nextTick, reactive } from 'vue'
import Input from '../src/component/input/Input.vue'
import Textarea from '../src/component/textarea/Textarea.vue'

const mounts = []

// 挂载时注入的 collectFormValue 桩，每个用例在 beforeEach 里重建，
// 用于断言表单值收集的时序而不只是最终结果
let collectFormValueMock

// 记录组件向 Form 注册的控件（getName/getValue/reset），用于模拟 Form 的 reset 按钮
// 直接调用 control.reset() 的场景，不只是丢弃注册回调
let registeredFormControls

function mountComponent(component, props = {}) {
	const host = document.createElement('div')
	document.body.appendChild(host)
	const app = createApp({
		setup() {
			provide('bridgeId', 'bridge-1')
			provide('path', 'page-path')
			provide('page-path', { id: 'module-1' })
			provide('collectFormValue', (...args) => collectFormValueMock(...args))
			provide('registerFormControl', (control) => {
				registeredFormControls.push(control)
				return () => {}
			})
			return () => h(component, props)
		},
	})
	app.mount(host)
	const mounted = { app, host }
	mounts.push(mounted)
	return mounted
}

// 从 window.__message.send 的调用记录里取某个方法名收到的所有 detail
function receivedDetails(methodName) {
	return window.__message.send.mock.calls
		.map(([message]) => message.body)
		.filter(body => body.methodName === methodName)
		.map(body => body.event.detail)
}

function dispatchInput(el, value, { isComposing = false, data } = {}) {
	el.value = value
	el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, isComposing, data }))
}

// 各引擎派发 compositionend 时，DOM 的 value 已经是提交（或取消）后的文本；引擎差异只在最终那次
// input 事件排在 compositionend 之前（Chrome/Android WebView）还是之后（Safari/Firefox）。
// 传 value 用来模拟“DOM 已提交但最终 input 还没到”的 Safari 顺序。
function dispatchComposition(el, type, data, { value } = {}) {
	if (value !== undefined) {
		el.value = value
	}
	el.dispatchEvent(new CompositionEvent(type, { bubbles: true, cancelable: true, data }))
}

function dispatchKeydown(el, keyCode, { isComposing = false } = {}) {
	const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, isComposing })
	// jsdom 的 KeyboardEvent 不认 init dict 里的 keyCode，需要手动覆盖只读属性
	Object.defineProperty(event, 'keyCode', { value: keyCode })
	el.dispatchEvent(event)
}

beforeEach(() => {
	collectFormValueMock = vi.fn()
	registeredFormControls = []
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

describe('input 组合输入语义', () => {
	function mountInput(extraProps = {}) {
		const { host } = mountComponent(Input, {
			bindinput: 'onInput',
			bindconfirm: 'onConfirm',
			bindblur: 'onBlur',
			...extraProps,
		})
		return host.querySelector('input')
	}

	it('Chrome 顺序：拼音中间态和组合中的最后一次 input 都不派发，只在 compositionend 后补发一次最终值', () => {
		const el = mountInput()

		dispatchComposition(el, 'compositionstart')
		dispatchInput(el, 'n', { isComposing: true })
		dispatchInput(el, 'ni', { isComposing: true })
		dispatchInput(el, 'nihao', { isComposing: true })
		dispatchInput(el, '你好', { isComposing: true })
		dispatchComposition(el, 'compositionend', '你好')

		const details = receivedDetails('onInput')
		expect(details.map(d => d.value)).toEqual(['你好'])
		expect(typeof details[0].cursor).toBe('number')
	})

	it('Safari 顺序：compositionend 先于最终 input 到达，随后的补发 input 不能重复派发', () => {
		const el = mountInput()

		dispatchComposition(el, 'compositionstart')
		dispatchInput(el, 'n', { isComposing: true })
		dispatchInput(el, 'ni', { isComposing: true })
		dispatchComposition(el, 'compositionend', '你好', { value: '你好' })
		dispatchInput(el, '你好', { isComposing: false })

		const details = receivedDetails('onInput')
		expect(details).toHaveLength(1)
		expect(details[0].value).toBe('你好')
	})

	it('组合结束后紧接着敲入普通字符，要正常派发不能被去重逻辑吞掉', () => {
		const el = mountInput()

		dispatchComposition(el, 'compositionstart')
		dispatchInput(el, 'n', { isComposing: true })
		dispatchInput(el, 'ni', { isComposing: true })
		dispatchComposition(el, 'compositionend', '你好', { value: '你好' })
		dispatchInput(el, '你好', { isComposing: false })
		dispatchInput(el, '你好a', { isComposing: false })

		const details = receivedDetails('onInput')
		expect(details.map(d => d.value)).toEqual(['你好', '你好a'])
	})

	it('组合期间的回车（keyCode 229）不触发 confirm 也不失焦，组合结束后的回车才 confirm', () => {
		const el = mountInput()
		el.focus()
		expect(document.activeElement).toBe(el)

		dispatchComposition(el, 'compositionstart')
		dispatchInput(el, 'nihao', { isComposing: true })
		dispatchKeydown(el, 229, { isComposing: true })

		expect(receivedDetails('onConfirm')).toEqual([])
		expect(receivedDetails('onBlur')).toEqual([])
		expect(document.activeElement).toBe(el)

		dispatchComposition(el, 'compositionend', '你好')
		dispatchInput(el, '你好', { isComposing: false })
		dispatchKeydown(el, 13)

		const confirms = receivedDetails('onConfirm')
		expect(confirms).toHaveLength(1)
		expect(confirms[0].value).toBe('你好')
	})

	it('组合结束后失焦拿到的是最终值，不是中间拼音', () => {
		const el = mountInput()

		dispatchComposition(el, 'compositionstart')
		dispatchInput(el, 'ni', { isComposing: true })
		dispatchInput(el, '你好', { isComposing: true })
		dispatchComposition(el, 'compositionend', '你好')
		el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))

		const blurs = receivedDetails('onBlur')
		expect(blurs).toHaveLength(1)
		expect(blurs[0].value).toBe('你好')
		expect(receivedDetails('onInput').some(d => d.value === 'ni')).toBe(false)
	})

	it('非组合的普通输入逐字派发，不受组合抑制影响', () => {
		const el = mountInput()

		dispatchInput(el, 'a')
		dispatchInput(el, 'ab')

		expect(receivedDetails('onInput').map(d => d.value)).toEqual(['a', 'ab'])
	})

	it('组合被空值打断后，后续普通输入照常派发', () => {
		const el = mountInput()

		dispatchComposition(el, 'compositionstart')
		dispatchInput(el, 'ni', { isComposing: true })
		dispatchComposition(el, 'compositionend', '', { value: '' })
		dispatchInput(el, 'a', { isComposing: false })

		const details = receivedDetails('onInput')
		expect(details.some(d => d.value === 'ni')).toBe(false)
		expect(details.some(d => d.value === 'a')).toBe(true)
	})

	it('compositionend 缺失时，收到 isComposing=false 的普通 input 应恢复派发', () => {
		const el = mountInput()

		dispatchComposition(el, 'compositionstart')
		dispatchInput(el, 'ni', { isComposing: true })
		// 引擎没有派发 compositionend（如被浏览器吞掉），后续输入已经不再是组合态
		dispatchInput(el, 'nia', { isComposing: false })

		const values = receivedDetails('onInput').map(d => d.value)
		expect(values).not.toContain('ni')
		expect(values).toContain('nia')
	})

	it('Safari 顺序下 compositionend 到达时，表单值和内部值必须已经是最终文本', () => {
		const el = mountInput()

		dispatchComposition(el, 'compositionstart')
		dispatchInput(el, 'ni', { isComposing: true })
		// Safari 下最终 input 还没到，compositionend 已经把 DOM 值提交为最终文本
		dispatchComposition(el, 'compositionend', '你好', { value: '你好' })

		const lastCall = collectFormValueMock.mock.calls.at(-1)
		expect(lastCall[1]).toBe('你好')
	})

	it('组合提交后没有补发 input（Chrome 顺序），外部把 value 改成别的值后再删回和提交值相同的文本，这次真实编辑必须派发', async () => {
		const props = reactive({
			bindinput: 'onInput',
			bindconfirm: 'onConfirm',
			bindblur: 'onBlur',
			value: '',
		})
		const { host } = mountComponent(Input, props)
		const el = host.querySelector('input')

		dispatchComposition(el, 'compositionstart')
		dispatchInput(el, '你', { isComposing: true })
		dispatchComposition(el, 'compositionend', '你', { value: '你' })

		// 外部把绑定的 value 改成别的文本（比如父组件重置了表单），和刚才的输入法组合无关
		props.value = '你a'
		await nextTick()
		expect(el.value).toBe('你a')

		// 用户真实删除一个字符，结果和刚才组合提交的值凑巧相同；这次删除不经过 keydown
		// （比如通过输入法候选栏的删除键或触控栏操作），不能被当成 compositionend 的重复回声吞掉
		dispatchInput(el, '你', { isComposing: false })

		const details = receivedDetails('onInput')
		expect(details.map(d => d.value)).toEqual(['你', '你'])
		const lastCall2 = collectFormValueMock.mock.calls.at(-1)
		expect(lastCall2[1]).toBe('你')
	})

	it('组合提交后没有补发 input（Chrome 顺序），Form 的 reset 按钮清空输入框后，不带 keydown 的粘贴出和提交值相同的文本必须派发', async () => {
		const el = mountInput()

		dispatchComposition(el, 'compositionstart')
		dispatchInput(el, '你', { isComposing: true })
		dispatchComposition(el, 'compositionend', '你', { value: '你' })

		// Form 的 reset 按钮直接调用注册的控件，把 DOM 值清空，这和刚才的组合提交无关
		registeredFormControls.at(-1).reset()
		await nextTick()
		expect(el.value).toBe('')

		// 不经过 keydown 的菜单粘贴，凑巧贴出和刚才组合提交值相同的文本
		dispatchInput(el, '你', { isComposing: false })

		const details = receivedDetails('onInput')
		expect(details.map(d => d.value)).toEqual(['你', '你'])
		const lastCall = collectFormValueMock.mock.calls.at(-1)
		expect(lastCall[1]).toBe('你')
	})

	it('组合提交后没有补发 input（Chrome 顺序），bindinput 回调把内容清空后，紧跟的一次不带 keydown 的输入（如菜单粘贴）即使和提交值相同也必须派发', async () => {
		const el = mountInput()

		dispatchComposition(el, 'compositionstart')
		dispatchInput(el, '你', { isComposing: true })
		dispatchComposition(el, 'compositionend', '你', { value: '你' })

		// 业务的 bindinput 回调把输入框清空（比如做了校验重置），这和刚才的组合提交无关
		const success = window.__callback.store.mock.calls.at(-1)[0]
		success('')
		await nextTick()

		// 不经过 keydown 的菜单粘贴，凑巧贴出和刚才组合提交值相同的文本
		dispatchInput(el, '你', { isComposing: false })

		const details = receivedDetails('onInput')
		expect(details.map(d => d.value)).toEqual(['你', '你'])
		const lastCall = collectFormValueMock.mock.calls.at(-1)
		expect(lastCall[1]).toBe('你')
	})
})

describe('textarea 组合输入语义', () => {
	function mountTextarea(extraProps = {}) {
		const { host } = mountComponent(Textarea, {
			bindinput: 'onInput',
			bindconfirm: 'onConfirm',
			bindblur: 'onBlur',
			bindlinechange: 'onLinechange',
			...extraProps,
		})
		return host.querySelector('textarea')
	}

	it('Chrome 顺序：拼音中间态不派发，只在 compositionend 后补发一次最终值', () => {
		const el = mountTextarea()

		dispatchComposition(el, 'compositionstart')
		dispatchInput(el, 'n', { isComposing: true })
		dispatchInput(el, 'ni', { isComposing: true })
		dispatchInput(el, 'nihao', { isComposing: true })
		dispatchInput(el, '你好', { isComposing: true })
		dispatchComposition(el, 'compositionend', '你好')

		const details = receivedDetails('onInput')
		expect(details.map(d => d.value)).toEqual(['你好'])
	})

	it('Safari 顺序：compositionend 先于最终 input 到达，随后的补发 input 不能重复派发', () => {
		const el = mountTextarea()

		dispatchComposition(el, 'compositionstart')
		dispatchInput(el, 'n', { isComposing: true })
		dispatchInput(el, 'ni', { isComposing: true })
		dispatchComposition(el, 'compositionend', '你好', { value: '你好' })
		dispatchInput(el, '你好', { isComposing: false })

		const details = receivedDetails('onInput')
		expect(details).toHaveLength(1)
		expect(details[0].value).toBe('你好')
	})

	it('组合期间的回车不触发 confirm，组合结束后的回车才 confirm', () => {
		const el = mountTextarea()
		el.focus()

		dispatchComposition(el, 'compositionstart')
		dispatchInput(el, 'nihao', { isComposing: true })
		dispatchKeydown(el, 229, { isComposing: true })

		expect(receivedDetails('onConfirm')).toEqual([])

		dispatchComposition(el, 'compositionend', '你好')
		dispatchInput(el, '你好', { isComposing: false })
		dispatchKeydown(el, 13)

		const confirms = receivedDetails('onConfirm')
		expect(confirms).toHaveLength(1)
		expect(confirms[0].value).toBe('你好')
	})

	it('非组合的普通输入逐字派发，不受组合抑制影响', () => {
		const el = mountTextarea()

		dispatchInput(el, 'a')
		dispatchInput(el, 'ab')

		expect(receivedDetails('onInput').map(d => d.value)).toEqual(['a', 'ab'])
	})

	it('普通输入引起行数变化时，应先收到 input 事件再收到 linechange 事件', () => {
		const el = mountTextarea()
		// jsdom 不做真实布局，scrollHeight 恒为 0；按当前内容的换行数模拟一次真实的高度增长，
		// 让 updateLineInfo 算出的行数与挂载时不同，才谈得上“行数变化”
		Object.defineProperty(el, 'scrollHeight', {
			configurable: true,
			get: () => 20 + (el.value.match(/\n/g) || []).length * 20,
		})
		// 只看这次输入触发的事件，排除挂载阶段 updateLineInfo 可能已经派发的 linechange
		window.__message.send.mockClear()

		dispatchInput(el, 'a\nb\nc', { isComposing: false })

		const methodNames = window.__message.send.mock.calls
			.map(([message]) => message.body.methodName)
			.filter(name => name === 'onInput' || name === 'onLinechange')
		expect(methodNames).toEqual(['onInput', 'onLinechange'])
	})

	it('组合期间拼音把内容折成多行时，行数变化不能在组合结束前抢先通知，最终只按提交值发一次', async () => {
		const el = mountTextarea()
		// 拼音中间态 'nihao' 和提交值 '你好' 在这次输入里都会折成 2 行，挂载时是 1 行
		const lineCountByValue = { nihao: 2, 你好: 2 }
		Object.defineProperty(el, 'scrollHeight', {
			configurable: true,
			get: () => 20 + ((lineCountByValue[el.value] ?? 1) - 1) * 20,
		})
		// 挂载时的行数测量在 nextTick 里完成，等它记下 1 行的基线再开始输入，和真实页面一致
		await nextTick()
		window.__message.send.mockClear()

		dispatchComposition(el, 'compositionstart')
		dispatchInput(el, 'nihao', { isComposing: true })

		// 组合还没结束，业务不该提前看到行数变化
		expect(receivedDetails('onLinechange')).toEqual([])

		dispatchComposition(el, 'compositionend', '你好', { value: '你好' })

		const methodNames = window.__message.send.mock.calls
			.map(([message]) => message.body.methodName)
			.filter(name => name === 'onInput' || name === 'onLinechange')
		expect(methodNames).toEqual(['onInput', 'onLinechange'])
		expect(receivedDetails('onInput')).toHaveLength(1)
		const linechanges = receivedDetails('onLinechange')
		expect(linechanges).toHaveLength(1)
		expect(linechanges[0].lineCount).toBe(2)
	})

	it('拼音中间态折成多行但选词后行数又变回原样时，全程不通知行数变化', async () => {
		const el = mountTextarea()
		// 中间态 'nihao' 折成 2 行，但最终提交值 '你' 又回到挂载时的 1 行——业务从未见过行数变化
		const lineCountByValue = { nihao: 2, 你: 1 }
		Object.defineProperty(el, 'scrollHeight', {
			configurable: true,
			get: () => 20 + ((lineCountByValue[el.value] ?? 1) - 1) * 20,
		})
		// 挂载时的行数测量在 nextTick 里完成，等它记下 1 行的基线再开始输入，和真实页面一致
		await nextTick()
		window.__message.send.mockClear()

		dispatchComposition(el, 'compositionstart')
		dispatchInput(el, 'nihao', { isComposing: true })
		dispatchComposition(el, 'compositionend', '你', { value: '你' })

		expect(receivedDetails('onLinechange')).toEqual([])
		expect(receivedDetails('onInput')).toHaveLength(1)
	})

	it('组合期间由 props 变化触发的行数测量不能提前通知业务', async () => {
		const props = reactive({
			bindinput: 'onInput',
			bindconfirm: 'onConfirm',
			bindblur: 'onBlur',
			bindlinechange: 'onLinechange',
			value: '',
			autoHeight: false,
		})
		const { host } = mountComponent(Textarea, props)
		const el = host.querySelector('textarea')
		// 拼音中间态 'nihao' 和提交值 '你好' 都折成 2 行，挂载时是 1 行
		const lineCountByValue = { nihao: 2, 你好: 2 }
		Object.defineProperty(el, 'scrollHeight', {
			configurable: true,
			get: () => 20 + ((lineCountByValue[el.value] ?? 1) - 1) * 20,
		})
		// 挂载时的行数测量在 nextTick 里完成，等它记下 1 行的基线再开始输入
		await nextTick()
		window.__message.send.mockClear()

		dispatchComposition(el, 'compositionstart')
		dispatchInput(el, 'nihao', { isComposing: true })

		// 组合还没结束，父组件这时改了别的 prop（比如切换 autoHeight），watch 依赖数组里
		// 一起带着 props.value 触发重新测量；这次测量不该抢在 compositionend 前通知业务
		props.autoHeight = true
		await nextTick()
		await nextTick()

		expect(receivedDetails('onLinechange')).toEqual([])

		dispatchComposition(el, 'compositionend', '你好', { value: '你好' })

		const methodNames = window.__message.send.mock.calls
			.map(([message]) => message.body.methodName)
			.filter(name => name === 'onInput' || name === 'onLinechange')
		expect(methodNames).toEqual(['onInput', 'onLinechange'])
		const linechanges = receivedDetails('onLinechange')
		expect(linechanges).toHaveLength(1)
		expect(linechanges[0].lineCount).toBe(2)
	})

	it('组合提交后没有补发 input（Chrome 顺序），外部把 value 改成别的值后再删回和提交值相同的文本，这次真实编辑必须派发', async () => {
		const props = reactive({
			bindinput: 'onInput',
			bindconfirm: 'onConfirm',
			bindblur: 'onBlur',
			bindlinechange: 'onLinechange',
			value: '',
		})
		const { host } = mountComponent(Textarea, props)
		const el = host.querySelector('textarea')

		dispatchComposition(el, 'compositionstart')
		dispatchInput(el, '你', { isComposing: true })
		dispatchComposition(el, 'compositionend', '你', { value: '你' })

		// 外部把绑定的 value 改成别的文本（比如父组件重置了表单），和刚才的输入法组合无关
		props.value = '你a'
		await nextTick()
		expect(el.value).toBe('你a')

		// 用户真实删除一个字符，结果和刚才组合提交的值凑巧相同；这次删除不经过 keydown
		// （比如通过输入法候选栏的删除键或触控栏操作），不能被当成 compositionend 的重复回声吞掉
		dispatchInput(el, '你', { isComposing: false })

		const details = receivedDetails('onInput')
		expect(details.map(d => d.value)).toEqual(['你', '你'])
		const lastCall2 = collectFormValueMock.mock.calls.at(-1)
		expect(lastCall2[1]).toBe('你')
	})

	it('组合提交后没有补发 input（Chrome 顺序），Form 的 reset 按钮清空输入框后，不带 keydown 的粘贴出和提交值相同的文本必须派发', async () => {
		const el = mountTextarea()

		dispatchComposition(el, 'compositionstart')
		dispatchInput(el, '你', { isComposing: true })
		dispatchComposition(el, 'compositionend', '你', { value: '你' })

		// Form 的 reset 按钮直接调用注册的控件，把 DOM 值清空，这和刚才的组合提交无关
		registeredFormControls.at(-1).reset()
		await nextTick()
		expect(el.value).toBe('')

		// 不经过 keydown 的菜单粘贴，凑巧贴出和刚才组合提交值相同的文本
		dispatchInput(el, '你', { isComposing: false })

		const details = receivedDetails('onInput')
		expect(details.map(d => d.value)).toEqual(['你', '你'])
		const lastCall = collectFormValueMock.mock.calls.at(-1)
		expect(lastCall[1]).toBe('你')
	})

	it('组合提交后没有补发 input（Chrome 顺序），bindinput 回调把内容清空后，紧跟的一次不带 keydown 的输入（如菜单粘贴）即使和提交值相同也必须派发', async () => {
		const el = mountTextarea()

		dispatchComposition(el, 'compositionstart')
		dispatchInput(el, '你', { isComposing: true })
		dispatchComposition(el, 'compositionend', '你', { value: '你' })

		// 业务的 bindinput 回调把输入框清空（比如做了校验重置），这和刚才的组合提交无关
		const success = window.__callback.store.mock.calls.at(-1)[0]
		success('')
		await nextTick()

		// 不经过 keydown 的菜单粘贴，凑巧贴出和刚才组合提交值相同的文本
		dispatchInput(el, '你', { isComposing: false })

		const details = receivedDetails('onInput')
		expect(details.map(d => d.value)).toEqual(['你', '你'])
		const lastCall = collectFormValueMock.mock.calls.at(-1)
		expect(lastCall[1]).toBe('你')
	})
})
