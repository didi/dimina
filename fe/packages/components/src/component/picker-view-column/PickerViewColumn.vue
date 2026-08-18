<script setup>
// 滚动选择器子项。仅可放置于picker-view中，其孩子节点的高度会自动设置成与picker-view的选中框的高度一致
// https://developers.weixin.qq.com/miniprogram/dev/component/picker-view-column.html

const indicatorRef = ref(null)
const maskRef = ref(null)
const contentRef = ref(null)
const currentY = ref(0)
const duration = ref('0.2s')
const pickerItemStyle = inject('pickerItemStyle', computed(() => ({})))
const pickerEvent = inject('pickerEvent', undefined)
const pickerImmediateChange = inject('pickerImmediateChange', computed(() => false))
const getPickerHeight = inject('getPickerHeight', () => 0)
const getItemIndex = inject('getItemIndex', () => 0)
const itemIndex = getItemIndex()
const setPickerValue = inject('setPickerValue', undefined)
const itemValue = inject('itemValue', ref(Array.from({ length: itemIndex }).fill(0)))

const indicatorClass = computed(() => pickerItemStyle.value.indicatorClass)
const maskClass = computed(() => pickerItemStyle.value.maskClass)
// 子节点行高，默认为34px
const nodeLineHeight = ref('34px')

let isDragging = false
let startY = 0
let moveY = 0
let startIndex = 0
let valueChanged = false
let dragDistance = 0

// 可选项最大索引。挂载后以真实 DOM 子节点为准，兼容 Fragment 和条件渲染。
let itemsSize = 0

// 选中项索引, 数字大于可选项长度时，选择最后一项
const currentIndex = ref(Math.min(itemValue.value[itemIndex] || 0, itemsSize))
let itemHeight = 0
let pendingEndEvent

setPickerValue?.(itemIndex, currentIndex.value)

function startDrag(event) {
	pickerEvent?.('pickstart', event)
	isDragging = true
	duration.value = '0s'
	startY = event.touches ? event.touches[0].clientY : event.clientY
	itemHeight = indicatorRef.value.offsetHeight
	startIndex = currentIndex.value
	valueChanged = false
	dragDistance = 0
	moveY = -currentIndex.value * itemHeight
}

function drag(event) {
	if (!isDragging)
		return
	dragDistance = (event.touches ? event.touches[0].clientY : event.clientY) - startY
	moveY = dragDistance - currentIndex.value * itemHeight
	currentY.value = moveY
}

function getTargetItemIndex(event) {
	let target = event.target
	while (target && target.parentElement !== contentRef.value) target = target.parentElement
	if (!target || target.parentElement !== contentRef.value) return -1
	return Array.from(contentRef.value.children).indexOf(target)
}

function endDrag(event) {
	if (!isDragging)
		return
	isDragging = false

	duration.value = '0.2s'

	itemsSize = Math.max((contentRef.value?.children.length || 1) - 1, 0)
	const targetIndex = Math.abs(dragDistance) < 3 ? getTargetItemIndex(event) : -1
	if (targetIndex >= 0) {
		currentIndex.value = targetIndex
		currentY.value = -currentIndex.value * itemHeight
	}
	else if (moveY < 0) {
		currentIndex.value = Math.min(itemsSize, Math.abs(Math.round(moveY / itemHeight)))
		currentY.value = -currentIndex.value * itemHeight
	}
	else {
		currentIndex.value = 0
		currentY.value = 0
	}
	setPickerValue?.(itemIndex, currentIndex.value)
	valueChanged = currentIndex.value !== startIndex
	if (pickerImmediateChange.value && valueChanged) {
		pickerEvent?.('change', event)
	}
	pendingEndEvent = event
	if (duration.value === '0s' || moveY === -currentIndex.value * itemHeight) {
		finishScroll()
	}
}

function finishScroll(event = pendingEndEvent) {
	if (!pendingEndEvent && !event) return
	if (!pickerImmediateChange.value && valueChanged) {
		pickerEvent?.('change', event)
	}
	pickerEvent?.('pickend', event)
	pendingEndEvent = undefined
}

watch(() => itemValue.value[itemIndex], (value) => {
	const nextIndex = Math.min(Math.max(Number(value) || 0, 0), itemsSize)
	currentIndex.value = nextIndex
	currentY.value = -nextIndex * itemHeight
})

function applyLayoutStyles() {
	if (!indicatorRef.value || !maskRef.value || !contentRef.value || !itemHeight) return
	const pickerHeight = getPickerHeight()
	const pTop = (pickerHeight - itemHeight) / 2
	indicatorRef.value.style.cssText = pickerItemStyle.value.indicatorStyle || ''
	indicatorRef.value.style.height = `${itemHeight}px`
	indicatorRef.value.style.top = `${pTop}px`
	maskRef.value.style.cssText = pickerItemStyle.value.maskStyle || ''
	maskRef.value.style.backgroundSize = `100% ${pTop}px`
	Array.from(contentRef.value.children).forEach((node) => {
		node.style.height = `${itemHeight}px`
	})
	contentRef.value.style.paddingTop = `${pTop}px`
}

watch(pickerItemStyle, () => applyLayoutStyles(), { deep: true })

onMounted(async () => {
	await nextTick()
	indicatorRef.value.style.cssText = pickerItemStyle.value.indicatorStyle || ''

	// 获取子节点的行高
	const firstChild = contentRef.value.firstElementChild
	if (firstChild) {
		const computedStyle = window.getComputedStyle(firstChild)
		const lineHeight = Number.parseFloat(computedStyle.lineHeight)
		const fontSize = Number.parseFloat(computedStyle.fontSize) || 16
		nodeLineHeight.value = `${Number.isFinite(lineHeight) ? lineHeight : fontSize * 1.2}px`
		// 设置 indicator 高度与子节点行高一致
		indicatorRef.value.style.height = nodeLineHeight.value
	}

	itemHeight = indicatorRef.value.offsetHeight || Number.parseFloat(nodeLineHeight.value) || 34
	itemsSize = Math.max(contentRef.value.children.length - 1, 0)
	currentIndex.value = Math.min(Math.max(Number(itemValue.value[itemIndex]) || 0, 0), itemsSize)
	setPickerValue?.(itemIndex, currentIndex.value)
	applyLayoutStyles()
	duration.value = '0s'
	currentY.value = -currentIndex.value * itemHeight
})
</script>

<template>
	<div v-bind="$attrs" class="dd-picker-view-column">
		<div aria-label="上下滚动进行选择" aria-dropeffect="move">
			<div ref="maskRef" class="dd-picker__mask" :class="maskClass" />
			<div ref="indicatorRef" class="dd-picker__indicator" :class="indicatorClass" />
			<div
				ref="contentRef" class="dd-picker__content" :style="{
					'--duration': duration,
					'transform': `translateY(${currentY}px)`,
				}" @transitionend.self="finishScroll" @touchstart="startDrag" @touchmove.prevent="drag" @touchend.prevent="endDrag" @touchcancel="endDrag"
				@mousedown="startDrag" @mousemove.prevent="drag" @mouseup="endDrag" @mouseleave="endDrag"
			>
				<slot />
			</div>
		</div>
	</div>
</template>

<style lang="scss">
.dd-picker-view-column {
	flex: 1;
	position: relative;
	z-index: 0;
	height: 100%;
	overflow: hidden;

	.dd-picker__mask {
		transform: translateZ(0);
	}

	.dd-picker__indicator,
	.dd-picker__mask {
		position: absolute;
		left: 0;
		width: 100%;
		z-index: 3;
	}

	.dd-picker__mask {
		top: 0;
		height: 100%;
		margin: 0 auto;
		background: linear-gradient(180deg, hsla(0, 0%, 100%, 0.95), hsla(0, 0%, 100%, 0.6)),
			linear-gradient(0deg, hsla(0, 0%, 100%, 0.95), hsla(0, 0%, 100%, 0.6));
		background-position: top, bottom;
		background-size: 100% 102px;
		background-repeat: no-repeat;
	}

	.dd-picker__indicator {
		top: 102px;
	}

	.dd-picker__indicator,
	.dd-picker__mask {
		position: absolute;
		left: 0;
		width: 100%;
		z-index: 3;
		pointer-events: none;
	}

	.dd-picker__content {
		position: absolute;
		top: 0;
		left: 0;
		width: 100%;
		transition: transform var(--duration) ease-out 0s;
		cursor: grab;
	}

	.dd-picker__indicator:after,
	.dd-picker__indicator:before {
		content: ' ';
		position: absolute;
		left: 0;
		right: 0;
		height: 1px;
		color: #e5e5e5;
	}

	.dd-picker__indicator:before {
		top: 0;
		border-top: 1px solid #e5e5e5;
		transform-origin: 0 0;
		transform: scaleY(0.5);
	}

	.dd-picker__indicator:after {
		bottom: 0;
		border-bottom: 1px solid #e5e5e5;
		transform-origin: 0 100%;
		transform: scaleY(0.5);
	}

	.dd-picker__indicator:after,
	.dd-picker__indicator:before {
		content: ' ';
		position: absolute;
		left: 0;
		right: 0;
		height: 1px;
		color: #e5e5e5;
	}
}
</style>
