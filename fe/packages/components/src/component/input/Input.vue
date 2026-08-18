<script setup>
// 输入框
// https://developers.weixin.qq.com/miniprogram/dev/component/input.html
// https://github.com/Tencent/weui/blob/master/src/example/input/input.html

import { isDesktop, transformRpx } from '@dimina/common'
import { invokeAPI, triggerEvent, useInfo } from '@/common/events'
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
		iValue.value = ''
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

watch(
	[() => props.focus, () => props.value],
	([nF, nV], [, preV]) => {
		if (nF) {
			inputRef.value.focus()
			applySelection()
		}
		if (preV !== nV) {
			iValue.value = nV
		}
	},
)

const wrapperRef = ref(null)
const info = useInfo()
const keyboardAccessoryVisible = ref(false)
provide('keyboardAccessoryVisible', keyboardAccessoryVisible)
useKeyboardHeight(info, keyboardAccessoryVisible)

function handleKeydown(event) {
	keyCode.value = event.keyCode
	if (event.keyCode === 13) {
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
		case 'input':
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
					iValue.value = data.value ?? data
					// Also update the parent when success callback modifies the value
					emit('update:value', data.value ?? data)
				},
			})
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
</script>

<template>
	<div
		ref="wrapperRef" v-bind="$attrs" :class="wrapperClass" role="textbox" data-dd-label-target @input="handleWrapperEvent"
		@focusin="handleWrapperEvent" @focusout="handleWrapperEvent" @change="handleWrapperEvent"
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
