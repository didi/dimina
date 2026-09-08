<script setup>
// 多行输入框。该组件是原生组件，使用时请注意相关限制。
// https://developers.weixin.qq.com/miniprogram/dev/component/textarea.html

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
	 * 输入框的内容
	 */
	value: {
		type: String,
		required: false,
		default: '',
	},
	/**
	 * 输入框为空时占位符
	 */
	placeholder: {
		type: String,
		required: false,
	},
	/**
	 * 指定 placeholder 的样式，目前仅支持color,font-size和font-weight
	 */
	placeholderStyle: {
		type: [String, Object],
		required: false,
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
		required: false,
	},
	/**
	 * 最大输入长度，设置为 -1 的时候不限制最大长度
	 */
	maxlength: {
		type: Number,
		default: 140,
		required: false,
	},
	/**
	 * 自动聚焦，拉起键盘
	 */
	autoFocus: {
		type: Boolean,
		default: false,
		required: false,
	},
	/**
	 * 获取焦点
	 */
	focus: {
		type: Boolean,
		default: false,
		required: false,
	},
	/**
	 * 是否自动增高，设置auto-height时，style.height不生效
	 */
	autoHeight: {
		type: Boolean,
		default: false,
		required: false,
	},
	/**
	 * 指定光标与键盘的距离。取textarea距离底部的距离和cursor-spacing指定的距离的最小值作为光标与键盘的距离
	 */
	cursorSpacing: {
		type: Number,
		default: 0,
		required: false,
	},
	/**
	 * 指定focus时的光标位置
	 */
	cursor: {
		type: Number,
		default: -1,
		required: false,
	},
	/**
	 * 是否显示键盘上方带有"完成"按钮那一栏
	 */
	showConfirmBar: {
		type: Boolean,
		default: true,
		required: false,
	},
	/**
	 * 光标起始位置，自动聚集时有效，需与selection-end搭配使用
	 */
	selectionStart: {
		type: Number,
		default: -1,
		required: false,
	},
	/**
	 * 光标结束位置，自动聚集时有效，需与selection-start搭配使用
	 */
	selectionEnd: {
		type: Number,
		default: -1,
		required: false,
	},
	/**
	 * 键盘弹起时，是否自动上推页面
	 */
	adjustPosition: {
		type: Boolean,
		default: true,
		required: false,
	},
	/**
	 * focus时，点击页面的时候不收起键盘
	 */
	holdKeyboard: {
		type: Boolean,
		default: false,
		required: false,
	},
	/**
	 * 是否去掉 iOS 下的默认内边距
	 */
	disableDefaultPadding: {
		type: Boolean,
		default: false,
		required: false,
	},
	/**
	 * 设置键盘右下角按钮的文字
	 */
	confirmType: {
		type: String,
		default: 'return',
		required: false,
		validator: value => ['send', 'search', 'next', 'go', 'done', 'return'].includes(value),
	},
	/**
	 * 点击键盘右下角按钮时是否保持键盘不收起
	 */
	confirmHold: {
		type: Boolean,
		default: false,
		required: false,
	},
	/**
	 * 键盘对齐位置
	 */
	adjustKeyboardTo: {
		type: String,
		default: 'cursor',
		required: false,
		validator: value => ['cursor', 'bottom'].includes(value),
	},
	/**
	 * 指定 placeholder 的样式类，目前仅支持color,font-size和font-weight
	 */
	placeholderClass: {
		type: String,
		default: 'textarea-placeholder',
	},
	/**
	 * 如果 textarea 是在一个 position:fixed 的区域，需要显示指定属性 fixed 为 true
	 */
	fixed: {
		type: Boolean,
		default: false,
	},
	keyboardAppearance: { type: String, default: 'default' },
	confirm: { type: Boolean, default: true },
	autoFill: { type: String, default: '' },
})

const emit = defineEmits(['update:value'])

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

const textareaRef = ref(null)
const keyCode = ref(null)

// 处理 placeholder 显示逻辑
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

/**
 * 自定义 v-focus 指令
 */
const vFocus = {
	mounted: (el) => {
		if (!props.autoFocus && !props.focus) {
			return
		}
		el.focus()
		applySelection(el)
	},
}

function applySelection(element = textareaRef.value) {
	if (!element?.setSelectionRange) return
	const cursor = Number(props.cursor)
	const start = cursor >= 0 ? cursor : Number(props.selectionStart)
	const end = cursor >= 0 ? cursor : Number(props.selectionEnd)
	if (start >= 0) element.setSelectionRange(start, end >= 0 ? end : start)
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
			textareaRef.value.focus()
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

// lastLineCount 记的是业务上次收到通知的行数。组合期间不论哪个入口触发测量（input、props watch），
// 都只跟随 DOM 更新 auto-height、不通知；组合结束派发完 input 再和它比较，
// 拼音临时折行又复原时业务不会收到多余的 linechange
let lastLineCount
function updateLineInfo(event) {
	const element = textareaRef.value
	if (!element) return
	const style = window.getComputedStyle(element)
	const fontSize = Number.parseFloat(style.fontSize) || 16
	const lineHeight = Number.parseFloat(style.lineHeight) || fontSize * 1.2
	const height = Math.max(element.scrollHeight, lineHeight)
	const lineCount = Math.max(Math.floor(height / lineHeight), 1)
	if (props.autoHeight) wrapperRef.value.style.height = `${height}px`
	if (!composing && lineCount !== lastLineCount) {
		lastLineCount = lineCount
		triggerEvent('linechange', {
			event,
			info,
			detail: {
				height,
				heightRpx: height * 750 / Math.max(window.innerWidth, 1),
				lineCount,
			},
		})
	}
}

onMounted(() => nextTick(() => updateLineInfo()))

watch(
	() => [props.value, props.autoHeight],
	() => nextTick(() => updateLineInfo()),
)

// 添加新的统一事件处理函数
function handleWrapperEvent(event) {
	// 确保事件来自 textarea 元素
	if (event.target.tagName.toLowerCase() !== 'textarea') {
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
			// 先派发 input 再通知行数，业务在 bindlinechange 里读到的是选词后的文本
			publishInput(event)
			updateLineInfo(event)
			break

		case 'input':
			// isComposing 由浏览器按规范维护：为 false 说明组合已经结束，即使没收到 compositionend 也要解除抑制
			if (composing && event.isComposing === false) {
				composing = false
			}
			if (composing) {
				// 组合期间只同步内部值和行高，让 :value 绑定和 auto-height 跟上 DOM，不派发给业务层
				collectFormValue?.(props.name, value)
				iValue.value = value
				updateLineInfo(event)
				break
			}
			if (consumeCommittedEcho(value)) {
				break
			}
			// 先派发 input 再算行信息，业务在 bindlinechange 里读到的是本次输入后的文本
			publishInput(event)
			updateLineInfo(event)
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
				const bottom = getActualBottom(element)
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

const wrapperClass = computed(() => {
	return {
		'dd-textarea-wrapper': true,
		'dd-textarea-disabled': props.disabled,
	}
})
</script>

<template>
	<div ref="wrapperRef" v-bind="$attrs" :class="wrapperClass" role="textbox" @input="handleWrapperEvent" @focusin="handleWrapperEvent" @focusout="handleWrapperEvent" @change="handleWrapperEvent" @compositionstart="handleWrapperEvent" @compositionend="handleWrapperEvent">
		<textarea
			:id="id" ref="textareaRef" v-focus class="dd-textarea" :value="iValue" :disabled="disabled"
			:maxlength="maxlength" :autocomplete="autoFill || undefined"
			@keydown="handleKeydown"
		/>
		<div
			v-show="placeholderShow" class="dd-textarea-placeholder" :class="placeholderClass"
			:style="computedPlaceholderStyle"
		>
			{{ placeholder }}
		</div>
		<slot />
	</div>
</template>

<style lang="scss">
.dd-textarea-wrapper {
	position: relative;
	width: 100%;
	height: 100%;
}

.dd-textarea {
	width: 100%;
	height: 100%;
	display: block;
	position: relative;
	outline: none;
	border: none;
	resize: none;
	background-color: transparent;
	line-height: 1.2;
	padding: 0;
	font-family: inherit;
	font-size: inherit;
	color: inherit;

	&::-webkit-scrollbar {
		display: none;
	}

	&[hidden] {
		display: none;
	}
}

.dd-textarea-placeholder {
	position: absolute;
	top: 0;
	left: 0;
	padding: inherit;
	pointer-events: none;

	&.textarea-placeholder {
		color: rgba(0, 0, 0, 0.3);
	}
}

.dd-textarea-disabled {
	opacity: 0.5;
}
</style>
