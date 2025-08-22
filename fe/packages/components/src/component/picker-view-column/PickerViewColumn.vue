<script setup>
// 滚动选择器子项。仅可放置于picker-view中，其孩子节点的高度会自动设置成与picker-view的选中框的高度一致
// https://developers.weixin.qq.com/miniprogram/dev/component/picker-view-column.html

const indicatorRef = ref(null)
const maskRef = ref(null)
const contentRef = ref(null)
const currentY = ref(0)
const duration = ref('0.2s')
const pickerItemStyle = inject('pickerItemStyle', {})
const pickerEvent = inject('pickerEvent', undefined)
const getPickerHeight = inject('getPickerHeight', () => 0)
const getItemIndex = inject('getItemIndex', () => 0)
const itemIndex = getItemIndex()
const setPickerValue = inject('setPickerValue', undefined)
const itemValue = inject('itemValue', Array.from({ length: itemIndex }).fill(0))

const indicatorClass = ref(pickerItemStyle.indicatorClass)
const maskClass = ref(pickerItemStyle.maskClass)
// 子节点行高，默认为34px
const nodeLineHeight = ref('34px')

let isDragging = false
let startY = 0
let moveY = 0

const slots = useSlots()
// 可选项长度
let itemsSize = slots.default ? Math.max(slots.default()[0].children.length - 1, 0) : 0

// 选中项索引, 数字大于可选项长度时，选择最后一项
const currentIndex = ref(Math.min(itemValue[itemIndex], itemsSize))
let itemHeight = 0

setPickerValue?.(itemIndex, currentIndex.value)

function startDrag(event) {
	pickerEvent?.('pickstart', event)
	isDragging = true
	startY = event.touches ? event.touches[0].clientY : event.clientY
	moveY = 0
	itemHeight = indicatorRef.value.offsetHeight
}

function drag(event) {
	if (!isDragging)
		return
	moveY = (event.touches ? event.touches[0].clientY : event.clientY) - startY - currentIndex.value * itemHeight
	currentY.value = moveY
}

function endDrag(event) {
	if (!isDragging)
		return
	isDragging = false

	duration.value = '0.2s'

	if (moveY < 0) {
		// 重新获取选项数量
		itemsSize = slots.default ? Math.max(slots.default()[0].children.length - 1, 0) : 0
		currentIndex.value = Math.min(itemsSize, Math.abs(Math.round(moveY / itemHeight)))
		currentY.value = -currentIndex.value * itemHeight
	}
	else {
		currentIndex.value = 0
		currentY.value = 0
	}
	setPickerValue?.(itemIndex, currentIndex.value)
	pickerEvent?.('change', event)
	pickerEvent?.('pickend', event)
}

onMounted(async () => {
	await nextTick()
	const pickerHeight = getPickerHeight()
	indicatorRef.value.style = pickerItemStyle.indicatorStyle

	// 获取子节点的行高
	if (slots.default && slots.default()[0].children.length > 0) {
		const firstChild = contentRef.value.querySelector(':first-child')
		if (firstChild) {
			const computedStyle = window.getComputedStyle(firstChild)
			nodeLineHeight.value = computedStyle.lineHeight || '34px'
			// 设置 indicator 高度与子节点行高一致
			indicatorRef.value.style.height = nodeLineHeight.value
		}
	}

	itemHeight = indicatorRef.value.offsetHeight

	const pTop = (pickerHeight - itemHeight) / 2
	indicatorRef.value.style.top = `${pTop}px`

	maskRef.value.style = pickerItemStyle.maskStyle
	maskRef.value.style.backgroundSize = `100% ${pTop}px`

	const slotNodes = contentRef.value.children
	Array.from(slotNodes).forEach((node) => {
		node.style.height = `${itemHeight}px`
	})
	contentRef.value.style.paddingTop = `${pTop}px`
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
				}" @touchstart="startDrag" @touchmove.prevent="drag" @touchend.prevent="endDrag" @touchcancel="endDrag"
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
