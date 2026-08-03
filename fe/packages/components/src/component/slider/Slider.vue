<script setup>
import { triggerEvent, useInfo } from '@/common/events'

// 滑动选择器
// https://developers.weixin.qq.com/miniprogram/dev/component/slider.html

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
	 * 最小值
	 */
	min: {
		type: Number,
		default: 0,
		required: false,
	},
	/**
	 * 最大值
	 */
	max: {
		type: Number,
		default: 100,
		required: false,
	},
	/**
	 * 步长，取值必须大于 0，并且可被(max - min)整除
	 */
	step: {
		type: Number,
		default: 1,
		required: false,
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
	 * 当前取值
	 */
	value: {
		type: Number,
		default: 0,
		required: false,
	},
	/**
	 * 背景条的颜色（请使用 backgroundColor）
	 */
	color: {
		type: String,
		default: '#e9e9e9',
		required: false,
	},
	/**
	 * 已选择的颜色（请使用 activeColor）
	 */
	selectedColor: {
		type: String,
		default: '#1aad19',
		required: false,
	},
	/**
	 * 进度条激活态颜色
	 */
	activeColor: {
		type: String,
		default: '#1aad19',
		required: false,
	},
	/**
	 * 进度条非激活态颜色
	 */
	backgroundColor: {
		type: String,
		default: '#e9e9e9',
		required: false,
	},
	/**
	 * 滑块的大小，取值范围为 12 - 28
	 */
	blockSize: {
		type: Number,
		default: 28,
		required: false,
		validator: value => value >= 12 && value <= 28,
	},
	/**
	 * 滑块的颜色
	 */
	blockColor: {
		type: String,
		default: '#ffffff',
		required: false,
	},
	/**
	 * 是否显示当前 value
	 */
	showValue: {
		type: Boolean,
		default: false,
		required: false,
	},
	autoFill: {
		type: String,
		default: '',
	},
})

const info = useInfo()

const DEFAULT_ACTIVE_COLOR = '#1aad19'
const DEFAULT_BACK_COLOR = '#e9e9e9'

// 微信语义（_getActiveColor）：activeColor 与默认值相同视为未设置，回退到
// selectedColor；两者都未设置用默认绿。按值比较而不是真值判断——真值判断
// 下显式传的默认值会遮蔽另一颜色。
const valColor = computed(() => {
	const { activeColor, selectedColor } = props
	if (activeColor !== DEFAULT_ACTIVE_COLOR) return activeColor
	if (selectedColor !== DEFAULT_ACTIVE_COLOR) return selectedColor
	return DEFAULT_ACTIVE_COLOR
})

// 微信语义（_getBackgroundColor）：backgroundColor 与默认值相同视为未设置，
// 回退到 color；都未设置用默认灰。props 默认值与微信基础库默认值一致，
// 因此「未显式传」与「显式传默认值」在值比较下等价。
const backColor = computed(() => {
	const { backgroundColor, color } = props
	if (backgroundColor !== DEFAULT_BACK_COLOR) return { backgroundColor }
	if (color !== DEFAULT_BACK_COLOR) return { backgroundColor: color }
	return { backgroundColor: DEFAULT_BACK_COLOR }
})

function decimalPlaces(value) {
	const num = Number(value)
	if (Number.isInteger(num)) return 0
	const [mantissa, exponentText] = num.toString().toLowerCase().split('e')
	const fractionDigits = mantissa.split('.')[1]?.length ?? 0
	const exponent = exponentText === undefined ? 0 : Number(exponentText)
	// 1.2e-7 的有效小数位是 1 - (-7) = 8，不能把指数部分计入尾数长度
	return Math.max(0, fractionDigits - exponent)
}

function roundToStep(value) {
	const min = Number(props.min)
	const max = Number(props.max)
	const step = Math.max(Number(props.step) || 1, Number.EPSILON)

	// Clamps a number between a minimum and maximum value.
	const clamp = Math.min(Math.max(value, min), max)
	const raw = min + Math.round((clamp - min) / step) * step
	// 小数步长按最大小数位截断，消除二进制浮点尾差（对齐微信基础库 _revalicateRange）
	const decimals = Math.max(decimalPlaces(min), decimalPlaces(max), decimalPlaces(step))
	const rounded = decimals > 0 ? Number(raw.toFixed(decimals)) : raw
	// 当 (max - min) 不能被 step 整除时，舍入值可能越过边界（如 0/10/6 -> 12）
	return Math.min(Math.max(rounded, min), max)
}

const sliderHandle = ref(null)
// 组件根元素。逻辑层通过 event.currentTarget 上的 data-sid 反查节点，
// 而 data-sid 只挂在根元素上（由 $attrs 绑入）。
const sliderRoot = ref(null)

// 格式化显示值
const disValue = ref(roundToStep(Number(props.value)))

// 注入父组件提供的方法
const collectFormValue = inject('collectFormValue', undefined)
const registerFormControl = inject('registerFormControl', undefined)
collectFormValue?.(props.name, disValue.value)

const range = computed(() => Number(props.max) - Number(props.min))

// 计算百分比
const percent = computed(() => {
	return range.value > 0 ? ((disValue.value - Number(props.min)) / range.value) * 100 : 0
})

// 滑块尺寸与微信基础库一致地夹在 [12, 28]：blockSize 超出范围不生效而是被截断
const blockSize = computed(() => {
	const raw = Number(props.blockSize) || 28
	return Math.min(Math.max(raw, 12), 28)
})

// 显示值宽度按范围内的最大整数位、负号、小数点和最大小数位计算，
// 避免长数值或负数发生折行、溢出
const valueTextWidth = computed(() => {
	const min = Number(props.min)
	const max = Number(props.max)
	const intDigits = Math.max(
		String(Math.trunc(Math.abs(min))).length,
		String(Math.trunc(Math.abs(max))).length
	)
	const decimals = Math.max(decimalPlaces(props.min), decimalPlaces(props.max), decimalPlaces(props.step))
	const signWidth = min < 0 ? 1 : 0
	const decimalPointWidth = decimals > 0 ? 1 : 0
	return `${signWidth + intDigits + decimalPointWidth + decimals}ch`
})

let isDragging = false
// 拖动起始值：结束位置与起点同值时不触发 change（微信基础库 _startValue 语义）
let dragStartValue = null

function startDrag() {
	if (props.disabled) {
		return
	}
	isDragging = true
	dragStartValue = disValue.value
}

watch(() => props.value, value => {
	disValue.value = roundToStep(Number(value))
	collectFormValue?.(props.name, disValue.value)
})

const unregisterFormControl = registerFormControl?.({
	getName: () => props.name,
	getValue: () => disValue.value,
	reset: () => {
		disValue.value = Number(props.min)
		collectFormValue?.(props.name, disValue.value)
	},
})
onBeforeUnmount(() => unregisterFormControl?.())

const blockStyle = computed(() => ({
	backgroundColor: props.blockColor,
	height: `${blockSize.value}px`,
	marginLeft: `${-blockSize.value / 2}px`,
	marginTop: `${-blockSize.value / 2}px`,
	width: `${blockSize.value}px`,
}))

/**
 * 把根元素充当事件的 currentTarget 后再交给 triggerEvent。
 *
 * 交互事件的原生 currentTarget 不是根元素：点击落在内部的 .dd-slider-tap-area 上，
 * 拖动过程中的 touchmove / touchend 挂在 window 上。两者都不带 data-sid，逻辑层
 * 反查不到节点就会静默丢弃事件，表现为 slider 能拖动但绑定的 bindchange /
 * bindchanging 从不触发。
 *
 * 位置计算仍使用原始事件，这里只用于事件上报。
 */
function bridgeEvent(event) {
	return {
		currentTarget: sliderRoot.value,
		target: event?.target ?? sliderRoot.value,
		pageX: event?.pageX,
		pageY: event?.pageY,
		touches: event?.touches,
		changedTouches: event?.changedTouches,
		cancelable: event?.cancelable,
		preventDefault: () => event?.preventDefault?.(),
		stopPropagation: () => event?.stopPropagation?.(),
	}
}

function drag(event) {
	if (!isDragging || Boolean(props.disabled)) {
		return
	}
	if (event.cancelable) {
		event.preventDefault()
	}
	updateValue(event)
}

// 按事件位置计算校正后的值并同步 disValue，返回该值；轨道尺寸未就绪时返回 null
function applyValue(event) {
	// touchend 时 touches 已清空，最终触点位于 changedTouches
	const touch = event.touches?.[0] ?? event.changedTouches?.[0]
	const clientX = touch?.clientX ?? event.clientX
	const rect = sliderHandle.value?.getBoundingClientRect()
	if (clientX === undefined || !rect?.width) {
		return null
	}
	const delta = clientX - rect.left
	const position = (delta / rect.width) * range.value + Number(props.min)
	const disV = roundToStep(position)

	if (disV !== disValue.value) {
		disValue.value = disV
		collectFormValue?.(props.name, disV)
	}
	return disV
}

function updateValue(event, eventType = 'changing') {
	const disV = applyValue(event)
	if (disV === null) {
		return
	}

	// 拖动过程中触发的事件（值未变化也照常上报，对齐微信 _onTrack 语义）
	triggerEvent(eventType, {
		event: bridgeEvent(event),
		info,
		detail: {
			value: disV,
		},
	})
}

function endDrag(event) {
	if (!isDragging || Boolean(props.disabled)) {
		return
	}

	isDragging = false
	// 先用释放触点更新最终值，再判断是否拖回起点
	const disV = applyValue(event)
	const startValue = dragStartValue
	dragStartValue = null
	if (disV === null || disV === startValue) {
		return
	}

	// 完成一次拖动后触发的事件
	triggerEvent('change', {
		event: bridgeEvent(event),
		info,
		detail: {
			value: disV,
		},
	})
}

function handleClick(event) {
	if (isDragging) {
		isDragging = false
		return
	}

	if (props.disabled) {
		return
	}
	const previousValue = disValue.value
	const disV = applyValue(event)
	// 点击落点与当前值相同：change 不重复触发
	if (disV === null || disV === previousValue) {
		return
	}
	triggerEvent('change', {
		event: bridgeEvent(event),
		info,
		detail: {
			value: disV,
		},
	})
}

onMounted(() => {
	window.addEventListener('mousemove', drag)
	window.addEventListener('mouseup', endDrag)
	window.addEventListener('touchmove', drag, { passive: false })
	window.addEventListener('touchend', endDrag)
	window.addEventListener('touchcancel', endDrag)
})

onBeforeUnmount(() => {
	window.removeEventListener('mousemove', drag)
	window.removeEventListener('mouseup', endDrag)
	window.removeEventListener('touchmove', drag)
	window.removeEventListener('touchend', endDrag)
	window.removeEventListener('touchcancel', endDrag)
})
</script>

<template>
	<div
		:id="id" ref="sliderRoot" v-bind="$attrs" class="dd-slider" role="slider" :aria-valuemin="min" :aria-valuemax="max"
		:aria-valuenow="disValue" :aria-disabled="disabled" :class="{ 'dd-slider-disabled': disabled }"
	>
		<div class="dd-slider-wrapper">
			<div ref="sliderHandle" class="dd-slider-tap-area" @click="handleClick">
				<div class="dd-slider-handle-wrapper" :style="backColor">
					<div
						class="dd-slider-handle" :style="{ ...blockStyle, left: `${percent}%`, backgroundColor: 'transparent' }" @touchstart="startDrag"
						@mousedown="startDrag"
					/>
					<div class="dd-slider-thumb" :style="{ ...blockStyle, left: `${percent}%` }" />
					<div class="dd-slider-track" :style="{ width: `${percent}%`, backgroundColor: valColor }" />
					<div class="dd-slider-step" />
				</div>
			</div>
			<span class="dd-slider-value" :hidden="!showValue">
				<p parse-text-content :style="{ width: valueTextWidth }">{{ disValue }}</p>
			</span>
		</div>
	</div>
</template>

<style lang="scss">
.dd-slider {
	margin: 10px 18px;
	padding: 0;
	display: block;

	&[hidden] {
		display: none;
	}
}

.dd-slider-wrapper {
	display: flex;
	align-items: center;
	min-height: 16px;
}

.dd-slider-tap-area {
	flex: 1;
	padding: 8px 0;
}

.dd-slider-handle-wrapper {
	position: relative;
	z-index: 0;
	height: 2px;
	border-radius: 5px;
	background-color: #e9e9e9;
	cursor: pointer;
	transition: background-color 0.3s ease;
	-webkit-tap-highlight-color: transparent;
}
.dd-slider-track {
	height: 100%;
	border-radius: 6px;
	background-color: #1aad19;
	transition: background-color 0.3s ease;
}
.dd-slider-handle,
.dd-slider-thumb {
	position: absolute;
	left: 0%;
	top: 50%;
	cursor: grab;
	border-radius: 50%;
	transition: border-color 0.3s ease;
}
.dd-slider-handle {
	width: 28px;
	height: 28px;
	margin-top: -14px;
	margin-left: -14px;
	background-color: transparent;
	z-index: 3;
}
.dd-slider-thumb {
	z-index: 2;
	box-shadow: 0 0 4px rgba(0, 0, 0, 0.2);
	width: 28px;
	height: 28px;
	margin-left: -14px;
	margin-top: -14px;
	background-color: rgb(255, 255, 255);
}
.dd-slider-step {
	position: absolute;
	width: 100%;
	height: 2px;
	background: transparent;
	z-index: 1;
}
.dd-slider-value {
	color: #888;
	font-size: 14px;
	margin-left: 1em;
	text-align: center;
}
.dd-slider-disabled .dd-slider-track {
	background-color: #ccc;
}
.dd-slider-disabled .dd-slider-thumb {
	background-color: #fff;
	border-color: #ccc;
}
</style>
