<script setup>
// 输入框
// https://developers.weixin.qq.com/miniprogram/dev/component/input.html
// https://github.com/Tencent/weui/blob/master/src/example/input/input.html

import { isDesktop, transformRpx } from '@dimina/common'
import { invokeAPI, triggerEvent, useInfo } from '@/common/events'
import { useLabelActivation } from '@/common/labelActivation'
import { useKeyboardHeight } from '@/common/useKeyboardHeight'
import { getActualBottom } from '@/common/utils'

const props = defineProps({
	/**
	 * id，为 label 使用
	 */
	id: {
		type: String,
	},
	/**
	 * name，为表单使用
	 */
	name: {
		type: String,
	},
	/**
	 * 输入框的初始内容
	 */
	value: {
		type: String,
		default: '',
	},
	/**
	 * input 的类型
	 * 合法值: text, number, idcard, digit, safe-password, nickname
	 */
	type: {
		type: String,
		default: 'text',
		validator: (value) => {
			return ['text', 'number', 'idcard', 'digit', 'safe-password', 'nickname'].includes(value)
		},
	},
	/**
	 * 是否是密码类型
	 */
	password: {
		type: Boolean,
		default: false,
	},
	/**
	 * 输入框为空时占位符
	 */
	placeholder: {
		type: String,
		default: '',
	},
	/**
	 * 指定 placeholder 的样式，目前仅支持color,font-size和font-weight
	 */
	placeholderStyle: {
		type: [String, Object],
		default() {
			return {}
		},
	},
	/**
	 * 是否禁用
	 */
	disabled: {
		type: Boolean,
		default: false,
	},
	/**
	 * 最大输入长度，设置为 -1 的时候不限制最大长度
	 */
	maxlength: {
		type: [Number, String],
		default: 140,
	},
	/**
	 * 指定光标与键盘的距离，取 input 距离底部的距离和 cursor-spacing 指定的距离的最小值作为光标与键盘的距离
	 */
	cursorSpacing: {
		type: Number,
		default: 0,
	},
	/**
	 * (即将废弃，请直接使用 focus )自动聚焦，拉起键盘
	 */
	autoFocus: {
		type: Boolean,
		default: false,
	},
	/**
	 * 获取焦点
	 */
	focus: {
		type: Boolean,
		default: false,
	},
	/**
	 * 设置键盘右下角按钮的文字，仅在type='text'时生效
	 * 合法值: send, search, next, go, done
	 */
	confirmType: {
		type: String,
		default: 'done',
		validator: (value) => {
			return ['send', 'search', 'next', 'go', 'done'].includes(value)
		},
	},
	/**
	 * 强制 input 处于同层状态，默认 focus 时 input 会切到非同层状态 (仅在 iOS 下生效)
	 */
	alwaysEmbed: {
		type: Boolean,
		default: false,
	},
	/**
	 * 点击键盘右下角按钮时是否保持键盘不收起
	 */
	confirmHold: {
		type: Boolean,
		default: false,
	},
	/**
	 * 指定focus时的光标位置
	 */
	cursor: {
		type: Number,
	},
	/**
	 * 光标颜色。iOS 下的格式为十六进制颜色值 #000000，安卓下的只支持 default 和 green
	 */
	cursorColor: {
		type: String,
	},
	/**
	 * 光标起始位置，自动聚集时有效，需与selection-end搭配使用
	 */
	selectionStart: {
		type: Number,
		default: -1,
	},
	selectionEnd: {
		type: Number,
		default: -1,
	},
	/**
	 * 键盘弹起时，是否自动上推页面
	 */
	adjustPosition: {
		type: Boolean,
		default: true,
	},
	/**
	 * focus时，点击页面的时候不收起键盘
	 */
	holdKeyboard: {
		type: Boolean,
		default: false,
	},
	/**
	 * WebView 特有属性
	 * 指定 placeholder 的样式类，目前仅支持color,font-size和font-weight
	 */
	placeholderClass: {
		type: String,
		default: 'input-placeholder',
	},
	keyboardAppearance: { type: String, default: 'default' },
	dropdownStyle: { type: Object, default: () => ({}) },
	autoFill: { type: String, default: '' },
	safePasswordCertPath: { type: String, default: null },
	safePasswordTimeStamp: { type: Number, default: null },
	safePasswordNonce: { type: Number, default: null },
	safePasswordSalt: { type: String, default: null },
	safePasswordCustomHash: { type: String },
	safePasswordLength: { type: Number, default: 6 },
})

const emit = defineEmits(['update:value'])

const wrapperClass = computed(() => {
	return {
		'dd-input-wrapper': true,
		'dd-input-disabled': props.disabled,
	}
})

const inputType = computed(() => {
	if (props.password || props.type === 'safe-password') {
		return 'password'
	}
	return props.type === 'number' || props.type === 'digit' ? 'text' : props.type
})

const inputMode = computed(() => {
	switch (props.type) {
		case 'number':
			return 'numeric'
		case 'digit':
			return 'decimal'
		default:
			return 'text'
	}
})

const computedPlaceholderStyle = computed(() => {
	// placeholder 的样式，目前仅支持color,font-size和font-weight
	const placeholderColor = () => {
		if (typeof props.placeholderStyle === 'string') {
			const match = props.placeholderStyle.match(/color:([^;]+)/)
			if (match) {
				return match[1].trim() // 提取匹配到的值并去除两端的空格
			}
		}
		else if (props.placeholderStyle && typeof props.placeholderStyle === 'object') {
			if (Object.prototype.hasOwnProperty.call(props.placeholderStyle, 'color')) {
				return props.placeholderStyle.color
			}
		}
		return 'rgba(0,0,0,.3)'
	}

	const placeholderFontSize = () => {
		let size
		if (typeof props.placeholderStyle === 'string') {
			const match = props.placeholderStyle.match(/font-size:([^;]+)/)
			if (match) {
				size = match[1].trim()
			}
		}
		else if (props.placeholderStyle && typeof props.placeholderStyle === 'object') {
			if (Object.prototype.hasOwnProperty.call(props.placeholderStyle, 'font-size')) {
				size = props.placeholderStyle['font-size']
			}
		}
		return size ? transformRpx(size) : 'inherit'
	}

	const placeholderFontWeight = () => {
		if (typeof props.placeholderStyle === 'string') {
			const match = props.placeholderStyle.match(/font-weight:([^;]+)/)
			if (match) {
				return match[1].trim()
			}
		}
		else if (props.placeholderStyle && typeof props.placeholderStyle === 'object') {
			if (Object.prototype.hasOwnProperty.call(props.placeholderStyle, 'font-weight')) {
				return props.placeholderStyle['font-weight']
			}
		}
		return 'inherit'
	}

	return {
		color: placeholderColor(),
		fontSize: placeholderFontSize(),
		fontWeight: placeholderFontWeight(),
	}
})

// 注入父组件提供的方法
const collectFormValue = inject('collectFormValue', undefined)
const registerFormControl = inject('registerFormControl', undefined)
collectFormValue?.(props.name, props.value)

// 处理placeholder样式
const iValue = ref(props.value)

const unregisterFormControl = registerFormControl?.({
	getName: () => props.name,
	getValue: () => iValue.value,
	reset: () => {
		applyExternalValue('')
		collectFormValue?.(props.name, iValue.value)
	},
})
onBeforeUnmount(() => unregisterFormControl?.())

const placeholderShow = computed(() => {
	return iValue.value === undefined || iValue.value === null || iValue.value === ''
		|| (typeof iValue.value === 'string' && iValue.value.length === 0)
})

const inputRef = ref(null)
const keyCode = ref(null)

const vFocus = {
	mounted: (el) => {
		if (!props.autoFocus && !props.focus) {
			return
		}
		el.focus()
		applySelection(el)
	},
}

function applySelection(element = inputRef.value) {
	if (!element?.setSelectionRange) return
	const cursor = Number(props.cursor)
	const start = cursor >= 0 ? cursor : Number(props.selectionStart)
	const end = cursor >= 0 ? cursor : Number(props.selectionEnd)
	if (start >= 0) {
		element.setSelectionRange(start, end >= 0 ? end : start)
	}
}

// 输入法组合期间（拼音还没选词）的中间值不是用户输入的结果，和微信一样不派发 bindinput，
// 等 compositionend 再用最终值补发一次
let composing = false
// Safari/Firefox 在 compositionend 之后还会补一次 isComposing=false 的 input，值就是刚提交的文本；
// 记住 compositionend 已派发的值，紧接着到达的同值 input 不再重复派发。
// 真实按键或外部改 value 之后到达的 input 都不可能是这次补发，标记随之作废
let committedValue = null

watch(
	[() => props.focus, () => props.value],
	([nF, nV], [, preV]) => {
		if (nF) {
			inputRef.value.focus()
			applySelection()
		}
		if (preV !== nV) {
			applyExternalValue(nV)
		}
	},
)

// props 或 bindinput 回调从 DOM 之外改写内部值：DOM 里那次组合提交的文本不再是当前值，
// 之后到达的同值 input 只能是真实输入（比如菜单粘贴），去重标记随之作废
function applyExternalValue(nextValue) {
	if (iValue.value !== nextValue) {
		committedValue = null
	}
	iValue.value = nextValue
}

const wrapperRef = ref(null)
// label 的激活入口登记在包裹层上：原生 <label> 的 click 转发已被 label 组件取消，
// 聚焦真实输入框这件事改由这里显式完成
useLabelActivation(wrapperRef, () => {
	if (props.disabled) {
		return
	}
	inputRef.value?.focus()
	applySelection()
})

const info = useInfo()
const keyboardAccessoryVisible = ref(false)
provide('keyboardAccessoryVisible', keyboardAccessoryVisible)
useKeyboardHeight(info, keyboardAccessoryVisible)

function handleKeydown(event) {
	keyCode.value = event.keyCode
	committedValue = null
	// 组合期间的回车是在选词，不是确认输入；部分浏览器此时 keyCode 仍是 13
	if (event.keyCode === 13 && !event.isComposing && !composing) {
		if (!props.confirmHold) {
			event.target.blur()
		}
		triggerEvent('confirm', {
			event,
			info,
			detail: {
				value: event.target.value,
			},
		})
	}
}

// 统一的事件处理函数
function handleWrapperEvent(event) {
	// 确保事件来自 input 元素
	if (event.target.tagName.toLowerCase() !== 'input') {
		return
	}
	const value = event.target.value
	switch (event.type) {
		case 'compositionstart':
			composing = true
			committedValue = null
			break

		case 'compositionend':
			composing = false
			committedValue = value
			publishInput(event)
			break

		case 'input':
			// isComposing 由浏览器按规范维护：为 false 说明组合已经结束，即使没收到 compositionend 也要解除抑制
			if (composing && event.isComposing === false) {
				composing = false
			}
			if (composing) {
				// 组合期间只同步内部值，让 :value 绑定跟上 DOM，不派发给业务层
				collectFormValue?.(props.name, value)
				iValue.value = value
				break
			}
			if (consumeCommittedEcho(value)) {
				break
			}
			publishInput(event)
			break

		case 'focusin':
			keyboardAccessoryVisible.value = true
			applySelection(event.target)
			triggerEvent('focus', {
				event,
				info,
				detail: {
					value,
				},
			})
			if (!isDesktop && props.adjustPosition) {
				const element = wrapperRef.value
				if (!element) {
					return
				}
				const bottom = getActualBottom(element, true)
				invokeAPI('adjustPosition', {
					bridgeId: info.bridgeId,
					params: {
						bottom,
					},
				})
			}
			break

		case 'focusout':
			// 失焦后不可能还在组合，即使输入法没有补发 compositionend 也要解除抑制
			composing = false
			committedValue = null
			keyboardAccessoryVisible.value = false
			triggerEvent('blur', {
				event,
				info,
				detail: {
					value,
					cursor: event.target.selectionEnd,
				},
			})
			break

		case 'change':
			triggerEvent('change', { event, info, detail: { value } })
			break
	}
}

// 只吞掉紧跟 compositionend、值未变的那一次 input；之后任何 input 都按真实输入派发
function consumeCommittedEcho(value) {
	if (committedValue === null) return false
	const echoed = value === committedValue
	committedValue = null
	return echoed
}

function publishInput(event) {
	const value = event.target.value
	collectFormValue?.(props.name, value)
	iValue.value = value
	// Emit update:value event for v-model binding with parent component
	emit('update:value', value)

	triggerEvent('input', {
		event,
		info,
		detail: {
			value,
			cursor: event.target.selectionEnd,
			keyCode: keyCode.value,
		},
		success: (data) => {
			const nextValue = data.value ?? data
			applyExternalValue(nextValue)
			emit('update:value', nextValue)
		},
	})
}
</script>

<template>
	<div
		ref="wrapperRef" v-bind="$attrs" :class="wrapperClass" role="textbox" data-dd-label-target @input="handleWrapperEvent"
		@focusin="handleWrapperEvent" @focusout="handleWrapperEvent" @change="handleWrapperEvent"
		@compositionstart="handleWrapperEvent" @compositionend="handleWrapperEvent"
	>
		<input
			:id="id" ref="inputRef" v-focus class="dd-input" :type="inputType" :inputmode="inputMode"
			:maxlength="maxlength" :value="iValue" :disabled="disabled"
			:autocomplete="autoFill || undefined" @keydown="handleKeydown"
		/>
		<div
			v-show="placeholderShow" class="dd-input-placeholder" :class="placeholderClass"
			:style="computedPlaceholderStyle"
		>
			{{ placeholder }}
		</div>
		<slot />
	</div>
</template>

<style lang="scss">
.dd-input-wrapper {
	position: relative;
	width: 100%;
	height: 100%;
}

.dd-input {
	border: none;
	width: 100%;
	outline: 0;
	appearance: none;
	background-color: transparent;
	font-family: inherit;
	font-size: inherit;
	color: inherit;
	height: inherit;
	display: block;
	padding: 0;
	margin: 0;
	text-align: inherit;
	overflow: inherit;
	white-space: inherit;
	text-overflow: inherit;

	// hides the spin-button
	&::-webkit-outer-spin-button,
	&::-webkit-inner-spin-button {
		appearance: none;
		margin: 0;
	}

}

.dd-input-placeholder {
	position: absolute;
	top: 0;
	width: 100%;
	height: 100%;
	pointer-events: none;
	display: flex;
	align-items: center;

	&.input-placeholder {
		color: rgba(0, 0, 0, 0.3);
	}
}

.dd-input-disabled {
	opacity: 0.5;
}
</style>
