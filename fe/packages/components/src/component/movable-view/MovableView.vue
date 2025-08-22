<script setup>
// 可移动的视图容器，在页面中可以拖拽滑动。movable-view 必须在 movable-area 组件中，并且必须是直接子节点，否则不能移动。
// https://developers.weixin.qq.com/miniprogram/dev/component/movable-view.html

import { triggerEvent, useInfo } from '@/common/events'

const props = defineProps({
	/**
	 * movable-view的移动方向，属性值有all、vertical、horizontal、none
	 */
	direction: {
		type: String,
		default: 'none',
		required: false,
		validator: value => ['all', 'vertical', 'horizontal', 'none'].includes(value),
	},
	/**
	 * movable-view是否带有惯性
	 */
	inertia: {
		type: Boolean,
		default: false,
		required: false,
	},
	/**
	 * 超过可移动区域后，movable-view是否还可以移动
	 */
	outOfBounds: {
		type: Boolean,
		default: false,
		required: false,
	},
	/**
	 * 定义x轴方向的偏移，如果x的值不在可移动范围内，会自动移动到可移动范围；改变x的值会触发动画；单位支持px（默认）、暂不支持 rpx；
	 */
	x: {
		type: [Number, String],
		default: 1,
		required: false,
	},
	/**
	 * 定义y轴方向的偏移，如果y的值不在可移动范围内，会自动移动到可移动范围；改变y的值会触发动画；单位支持px（默认）、暂不支持 rpx；
	 */
	y: {
		type: [Number, String],
		default: 1,
		required: false,
	},
	/**
	 * 阻尼系数，用于控制x或y改变时的动画和过界回弹的动画
	 */
	damping: {
		type: Number,
		default: 20,
		required: false,
	},
	/**
	 * 摩擦系数，用于控制惯性滑动的动画
	 */
	friction: {
		type: Number,
		default: 2,
		required: false,
		validator: value => value > 0,
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
	 * 是否支持双指缩放
	 */
	scale: {
		type: Boolean,
		default: false,
		required: false,
	},
	/**
	 * 定义缩放倍数最小值
	 */
	scaleMin: {
		type: Number,
		default: 0.1,
		required: false,
	},
	/**
	 * 定义缩放倍数最大值
	 */
	scaleMax: {
		type: Number,
		default: 10,
		required: false,
	},
	/**
	 * 定义缩放倍数
	 */
	scaleValue: {
		type: Number,
		default: 1,
		required: false,
		validator: value => value >= 0.1 && value <= 10,
	},
	/**
	 * 是否使用动画
	 */
	animation: {
		type: Boolean,
		default: true,
		required: false,
	},
})
const emit = defineEmits(['update:x', 'update:y'])
const info = useInfo()
const movableView = ref(null)
const movableViewContent = ref(null)
let startX = 0
let startY = 0
const currentX = ref(Number.isNaN(props.x) ? 1 : Number.parseFloat(props.x))
const currentY = ref(Number.isNaN(props.y) ? 1 : Number.parseFloat(props.y))
const duration = ref(props.animation ? '0.5s' : '0s')
let isDragging = false
let isUpdatingFromDrag = false
let parentRect = { width: 0, height: 0 }
let childRect = { width: 0, height: 0 }
let lastPositionX = 0
let lastPositionY = 0
let rafId = null

let resizeObserver = null

onMounted(() => {
	resizeObserver = new ResizeObserver(() => {
		requestAnimationFrame(() => {
			updateRects()
		})
	})

	if (movableView.value && movableView.value.parentElement) {
		resizeObserver.observe(movableView.value.parentElement)
		resizeObserver.observe(movableViewContent.value)
	}

	nextTick(() => {
		updateRects()
		duration.value = '0s'
		const { x: constrainedX, y: constrainedY } = constrainPosition(currentX.value, currentY.value)
		currentX.value = constrainedX
		currentY.value = constrainedY
	})
})

onUnmounted(() => {
	if (resizeObserver) {
		resizeObserver.disconnect()
		resizeObserver = null
	}
	if (rafId) {
		cancelAnimationFrame(rafId)
		rafId = null
	}
})

function updateRects() {
	parentRect = movableView.value.parentElement.getBoundingClientRect()
	childRect = movableViewContent.value.getBoundingClientRect()

	if (parentRect.width >= childRect.width) {
		lastPositionX = parentRect.x
	}
	else {
		lastPositionX = childRect.x
	}

	if (parentRect.height >= childRect.height) {
		lastPositionY = parentRect.y
	}
	else {
		lastPositionY = childRect.y
	}
}

function constrainPosition(x, y) {
	if (!parentRect || !childRect)
		return { x, y }

	let constrainedX = x
	let constrainedY = y

	if (parentRect.width >= childRect.width) {
		constrainedX = Math.min(Math.max(x, 0), parentRect.width - childRect.width)
	}
	else {
		constrainedX = Math.min(Math.max(x, parentRect.width - childRect.width), 0)
	}

	if (parentRect.height >= childRect.height) {
		constrainedY = Math.min(Math.max(y, 0), parentRect.height - childRect.height)
	}
	else {
		constrainedY = Math.min(Math.max(y, parentRect.height - childRect.height), 0)
	}

	return { x: constrainedX, y: constrainedY }
}

function startDrag(event) {
	if (props.disabled) {
		triggerEvent('touchstart', { event, info })
		return
	}
	duration.value = '0s'

	isDragging = true
	startX = (event.touches ? event.touches[0].clientX : event.clientX) - currentX.value
	startY = (event.touches ? event.touches[0].clientY : event.clientY) - currentY.value
	triggerEvent('touchstart', { event, info })
}

function drag(event) {
	if (props.disabled || !isDragging) {
		if (props.disabled) {
			triggerEvent('touchmove', { event, info })
		}
		return
	}

	event.stopPropagation()

	if (rafId) {
		cancelAnimationFrame(rafId)
	}

	rafId = requestAnimationFrame(() => {
		const nX = event.touches ? event.touches[0].clientX : event.clientX
		const nY = event.touches ? event.touches[0].clientY : event.clientY

		const dx = nX - startX
		const dy = nY - startY

		const { x: constrainedX, y: constrainedY } = constrainPosition(dx, dy)

		const rect = movableViewContent.value.getBoundingClientRect()
		const x = rect.x - lastPositionX
		const y = rect.y - lastPositionY

		isUpdatingFromDrag = true

		if (props.direction === 'horizontal') {
			currentX.value = constrainedX
			emit('update:x', constrainedX)
		}
		else if (props.direction === 'vertical') {
			currentY.value = constrainedY
			emit('update:y', constrainedY)
		}
		else if (props.direction === 'all') {
			currentX.value = constrainedX
			currentY.value = constrainedY
			emit('update:x', constrainedX)
			emit('update:y', constrainedY)
		}

		triggerEvent('change', {
			event,
			info,
			detail: {
				x,
				y,
				source: 'touch',
			},
		})
	})
}

function endDrag(event) {
	if (props.disabled) {
		triggerEvent('touchend', { event, info })
		return
	}

	if (!isDragging) {
		return
	}

	isDragging = false
	isUpdatingFromDrag = false
	duration.value = props.animation ? '0.5s' : '0s'

	if (rafId) {
		cancelAnimationFrame(rafId)
		rafId = null
	}

	triggerEvent('touchend', { event, info })
}

watch([() => props.x, () => props.y], ([nX, nY], [pX, pY]) => {
	if (isUpdatingFromDrag) {
		return
	}

	if (nX === pX && nY === pY) {
		return
	}
	const x = Number.isNaN(nX) ? 1 : Number.parseFloat(nX)
	const y = Number.isNaN(nY) ? 1 : Number.parseFloat(nY)
	const { x: constrainedX, y: constrainedY } = constrainPosition(x, y)
	duration.value = props.animation ? '0.5s' : '0s'
	currentX.value = constrainedX
	currentY.value = constrainedY
}, { flush: 'post' })
</script>

<template>
	<div
		ref="movableView" v-bind="$attrs" class="dd-movable-view" :class="[`direction-${direction}`]"
		aria-dropeffect="move" aria-label="可移动" @touchstart="startDrag" @touchmove="drag" @touchend="endDrag"
		@touchcancel="endDrag" @mousedown="startDrag" @mousemove="drag" @mouseup="endDrag" @mouseleave="endDrag"
	>
		<div
			ref="movableViewContent" class="dd-movable-view-content" :style="{
				'--duration': duration,
				'transform': `translate3d(${currentX}px, ${currentY}px, 0) scale(${scaleValue})`,
			}"
		>
			<slot />
		</div>
	</div>
</template>

<style lang="scss">
.dd-movable-view {
	display: inline-block;
	width: 10px;
	height: 10px;
	top: 0;
	left: 0;
	position: absolute;
	visibility: hidden;
	cursor: grab;

	&.direction-horizontal {
		touch-action: pan-y;
	}

	&.direction-vertical {
		touch-action: pan-x;
	}

	&.direction-all {
		touch-action: none;
	}

	&.direction-none {
		touch-action: auto;
	}

	.dd-movable-view-content {
		all: inherit;
		visibility: visible;
		-webkit-overflow-scrolling: touch;
		top: 0;
		left: 0;
		transition-property: transform;
		transition-duration: var(--duration);
		transition-timing-function: ease-out;
		transform-origin: center center;
		will-change: transform;
		backface-visibility: hidden;
		-webkit-backface-visibility: hidden;
	}

	&[hidden] {
		display: none;
	}
}
</style>
