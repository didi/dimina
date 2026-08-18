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
		default: 0,
		required: false,
	},
	/**
	 * 定义y轴方向的偏移，如果y的值不在可移动范围内，会自动移动到可移动范围；改变y的值会触发动画；单位支持px（默认）、暂不支持 rpx；
	 */
	y: {
		type: [Number, String],
		default: 0,
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
		default: 0.5,
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
		validator: value => value >= 0.5 && value <= 10,
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
const registerMovableView = inject('registerMovableView', undefined)
const movableView = ref(null)
const movableViewContent = ref(null)
let startX = 0
let startY = 0
function parseCoordinate(value) {
	const parsed = Number.parseFloat(value)
	return Number.isFinite(parsed) ? parsed : 0
}
const currentX = ref(parseCoordinate(props.x))
const currentY = ref(parseCoordinate(props.y))
const currentScale = ref(Math.min(Math.max(props.scaleValue, props.scaleMin, 0.5), props.scaleMax, 10))
const duration = ref(props.animation ? '0.5s' : '0s')
let isDragging = false
let isScaling = false
let isUpdatingFromDrag = false
let parentRect = { width: 0, height: 0 }
let childRect = { width: 0, height: 0 }
let lastPositionX = 0
let lastPositionY = 0
let rafId = null
let startDistance = 0
let startScale = 1
let lastPointerX = 0
let lastPointerY = 0
let lastPointerTime = 0
let velocityX = 0
let velocityY = 0

let resizeObserver = null
let unregisterMovableView

onMounted(() => {
	unregisterMovableView = registerMovableView?.({ start: startDrag, move: drag, end: endDrag })
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
	unregisterMovableView?.()
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
	childRect = {
		width: movableViewContent.value.offsetWidth,
		height: movableViewContent.value.offsetHeight,
	}

	if (parentRect.width >= childRect.width) {
		lastPositionX = parentRect.x
	}
	else {
		lastPositionX = parentRect.x
	}

	if (parentRect.height >= childRect.height) {
		lastPositionY = parentRect.y
	}
	else {
		lastPositionY = parentRect.y
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
	if (props.scale && event.touches?.length >= 2) {
		const [first, second] = event.touches
		startDistance = Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY)
		startScale = currentScale.value
		isScaling = true
		isDragging = false
		triggerEvent('touchstart', { event, info })
		return
	}

	isDragging = true
	const pointer = event.touches ? event.touches[0] : event
	startX = pointer.clientX - currentX.value
	startY = pointer.clientY - currentY.value
	lastPointerX = pointer.clientX
	lastPointerY = pointer.clientY
	lastPointerTime = event.timeStamp || performance.now()
	velocityX = 0
	velocityY = 0
	triggerEvent('touchstart', { event, info })
}

function drag(event) {
	if (isScaling && event.touches?.length >= 2) {
		if (event.cancelable) event.preventDefault()
		const [first, second] = event.touches
		const distance = Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY)
		const scale = Math.min(Math.max(startScale * distance / Math.max(startDistance, 1), props.scaleMin, 0.5), props.scaleMax, 10)
		if (scale !== currentScale.value) {
			currentScale.value = Number(scale.toFixed(3))
			triggerEvent('scale', {
				event,
				info,
				detail: { scale: currentScale.value, x: currentX.value, y: currentY.value },
			})
		}
		return
	}
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
		const time = event.timeStamp || performance.now()
		const elapsed = Math.max(time - lastPointerTime, 1)
		velocityX = (nX - lastPointerX) / elapsed
		velocityY = (nY - lastPointerY) / elapsed
		lastPointerX = nX
		lastPointerY = nY
		lastPointerTime = time

		const dx = nX - startX
		const dy = nY - startY
		const constrained = constrainPosition(dx, dy)
		const damp = (value, boundary) => boundary + (value - boundary) / Math.max(props.damping / 5, 1)
		const constrainedX = props.outOfBounds && constrained.x !== dx ? damp(dx, constrained.x) : constrained.x
		const constrainedY = props.outOfBounds && constrained.y !== dy ? damp(dy, constrained.y) : constrained.y

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

		if (props.direction !== 'none') {
			triggerEvent('change', {
				event,
				info,
				detail: {
					x: currentX.value,
					y: currentY.value,
					source: constrained.x === dx && constrained.y === dy ? 'touch' : 'touch-out-of-bounds',
				},
			})
		}
	})
}

function endDrag(event) {
	if (props.disabled) {
		triggerEvent('touchend', { event, info })
		return
	}

	if (isScaling) {
		isScaling = false
		triggerEvent('touchend', { event, info })
		return
	}

	if (!isDragging) {
		return
	}

	isDragging = false
	isUpdatingFromDrag = false
	const constrained = constrainPosition(currentX.value, currentY.value)
	let nextX = constrained.x
	let nextY = constrained.y
	let source = constrained.x !== currentX.value || constrained.y !== currentY.value ? 'out-of-bounds' : ''
	if (!source && props.inertia) {
		const inertiaFactor = 180 / Math.max(props.friction, 0.01)
		const inertiaPosition = constrainPosition(
			currentX.value + velocityX * inertiaFactor,
			currentY.value + velocityY * inertiaFactor,
		)
		nextX = inertiaPosition.x
		nextY = inertiaPosition.y
		source = nextX !== currentX.value || nextY !== currentY.value ? 'friction' : ''
	}
	duration.value = props.animation && source ? `${Math.max(120, 600 / Math.max(props.damping / 10, 1))}ms` : '0s'
	if (source) {
		currentX.value = nextX
		currentY.value = nextY
		emit('update:x', nextX)
		emit('update:y', nextY)
		triggerEvent('change', { event, info, detail: { x: nextX, y: nextY, source } })
	}

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
	const x = parseCoordinate(nX)
	const y = parseCoordinate(nY)
	const { x: constrainedX, y: constrainedY } = constrainPosition(x, y)
	duration.value = props.animation ? '0.5s' : '0s'
	currentX.value = constrainedX
	currentY.value = constrainedY
}, { flush: 'post' })

watch([() => props.scaleValue, () => props.scaleMin, () => props.scaleMax], ([value]) => {
	if (!props.scale) return
	currentScale.value = Math.min(Math.max(Number(value) || 1, props.scaleMin, 0.5), props.scaleMax, 10)
})
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
				'transform': `translate3d(${currentX}px, ${currentY}px, 0) scale(${currentScale})`,
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
