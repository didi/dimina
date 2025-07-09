<script setup>
// 多行输入框。该组件是原生组件，使用时请注意相关限制。
// https://developers.weixin.qq.com/miniprogram/dev/component/textarea.html

import { isDesktop, sleep, transformRpx } from '@dimina/common'
import { invokeAPI, triggerEvent, useInfo } from '@/common/events'
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
			if (Object.hasOwn(props.placeholderStyle, 'color')) {
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
			if (Object.hasOwn(props.placeholderStyle, 'font-size')) {
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
			if (Object.hasOwn(props.placeholderStyle, 'font-weight')) {
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
collectFormValue?.(props.name, props.value)

const textareaRef = ref(null)
const keyCode = ref(null)

// 处理 placeholder 显示逻辑
const iValue = ref(props.value)

const placeholderShow = computed(() => {
	return iValue.value === undefined || iValue.value === null || iValue.value === ''
		|| (typeof iValue.value === 'string' && iValue.value.length === 0)
})

/**
 * 自定义 v-focus 指令
 */
const vFocus = {
	mounted: async (el) => {
		if (!props.autoFocus) {
			return
		}
		if (isDesktop) {
			// 兼容 web 端页面进入动画
			await sleep(540)
		}
		el.focus()
	},
}

watch(
	[() => props.focus, () => props.value],
	([nF, nV], [, preV]) => {
		nF && textareaRef.value.focus()
		if (preV !== nV) {
			iValue.value = nV
		}
	},
)

const wrapperRef = ref(null)
const info = useInfo()

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

// 添加新的统一事件处理函数
function handleWrapperEvent(event) {
	// 确保事件来自 textarea 元素
	if (event.target.tagName.toLowerCase() !== 'textarea') {
		return
	}

	const value = event.target.value

	switch (event.type) {
		case 'input':
			collectFormValue?.(props.name, value)
			iValue.value = value

			// same as input
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

					emit('update:value', data.value ?? data)
				},
			})
			break

		case 'focusin':
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
			triggerEvent('blur', {
				event,
				info,
				detail: {
					value,
					cursor: event.target.selectionEnd,
				},
			})
			break
	}
}

const wrapperClass = computed(() => {
	return {
		'dd-textarea-wrapper': true,
		'dd-textarea-disabled': props.disabled,
	}
})
</script>

<template>
	<div ref="wrapperRef" v-bind="$attrs" :class="wrapperClass" role="textbox" @input="handleWrapperEvent" @focusin="handleWrapperEvent" @focusout="handleWrapperEvent">
		<textarea
			:id="id" ref="textareaRef" v-focus class="dd-textarea" :value="iValue" :disabled="disabled"
			@keydown="handleKeydown"
		/>
		<div
			v-show="placeholderShow" class="dd-textarea-placeholder" :class="placeholderClass"
			:style="computedPlaceholderStyle"
		>
			{{ placeholder }}
		</div>
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
