<template>
	<div class="dd-picker-column">
		<div class="dd-picker-column-mask"></div>
		<div class="dd-picker-column-indicator"></div>
		<div 
			class="dd-picker-column-content"
			ref="columnRef"
			@touchstart="handleTouchStart"
			@touchmove="handleTouchMove"
			@touchend="handleTouchEnd"
			@mousedown="handleMouseDown"
		>
			<div
				v-for="(option, index) in options"
				:key="index"
				class="dd-picker-column-item"
				:class="{ 'dd-picker-column-item-selected': index === currentIndex }"
			>
				{{ option }}
			</div>
		</div>
	</div>
</template>

<script setup>
const props = defineProps({
	options: {
		type: Array,
		default: () => []
	},
	value: {
		type: Number,
		default: 0
	}
})

const emit = defineEmits(['change'])

const columnRef = ref(null)
const currentIndex = ref(props.value)
const startY = ref(0)
const currentY = ref(0)
const isDragging = ref(false)
const itemHeight = 44 // 每个选项的高度

// 监听value变化
watch(() => props.value, (newVal) => {
	// 只有在不拖拽时才更新位置，避免与用户交互冲突
	if (!isDragging.value) {
		if (newVal !== currentIndex.value) {
			currentIndex.value = newVal
		}
		updatePosition()
	}
})

// 监听options变化
watch(() => props.options, () => {
	nextTick(() => {
		// 只有在不拖拽时才更新，避免干扰用户操作
		if (!isDragging.value) {
			updatePosition()
		}
	})
})

onMounted(() => {
	updatePosition()
})

// 更新位置
const updatePosition = () => {
	if (!columnRef.value) return
	
	const translateY = -currentIndex.value * itemHeight
	columnRef.value.style.transform = `translateY(${translateY}px)`
	columnRef.value.style.transition = 'transform 0.3s ease'
}

// 触摸开始
const handleTouchStart = (e) => {
	isDragging.value = true
	startY.value = e.touches[0].clientY
	currentY.value = e.touches[0].clientY
	
	if (columnRef.value) {
		columnRef.value.style.transition = 'none'
	}
}

// 触摸移动
const handleTouchMove = (e) => {
	if (!isDragging.value) return
	
	e.preventDefault()
	currentY.value = e.touches[0].clientY
	const deltaY = currentY.value - startY.value
	const translateY = -currentIndex.value * itemHeight + deltaY
	
	if (columnRef.value) {
		columnRef.value.style.transform = `translateY(${translateY}px)`
	}
}

// 触摸结束
const handleTouchEnd = (e) => {
	if (!isDragging.value) return
	
	isDragging.value = false
	const deltaY = currentY.value - startY.value
	const moveCount = Math.round(deltaY / itemHeight)
	let newIndex = currentIndex.value - moveCount
	
	// 边界检查
	newIndex = Math.max(0, Math.min(newIndex, props.options.length - 1))
	
	if (newIndex !== currentIndex.value) {
		currentIndex.value = newIndex
		emit('change', e, newIndex)
	}
	
	updatePosition()
}

// 鼠标事件支持（桌面端）
const handleMouseDown = (e) => {
	isDragging.value = true
	startY.value = e.clientY
	currentY.value = e.clientY
	
	if (columnRef.value) {
		columnRef.value.style.transition = 'none'
	}
	
	const handleMouseMove = (e) => {
		if (!isDragging.value) return
		
		currentY.value = e.clientY
		const deltaY = currentY.value - startY.value
		const translateY = -currentIndex.value * itemHeight + deltaY
		
		if (columnRef.value) {
			columnRef.value.style.transform = `translateY(${translateY}px)`
		}
	}
	
	const handleMouseUp = (e) => {
		if (!isDragging.value) return
		
		isDragging.value = false
		const deltaY = currentY.value - startY.value
		const moveCount = Math.round(deltaY / itemHeight)
		let newIndex = currentIndex.value - moveCount
		
		// 边界检查
		newIndex = Math.max(0, Math.min(newIndex, props.options.length - 1))
		
		if (newIndex !== currentIndex.value) {
			currentIndex.value = newIndex
			emit('change', e, newIndex)
		}
		
		updatePosition()
		
		document.removeEventListener('mousemove', handleMouseMove)
		document.removeEventListener('mouseup', handleMouseUp)
	}
	
	document.addEventListener('mousemove', handleMouseMove)
	document.addEventListener('mouseup', handleMouseUp)
}
</script>

<style lang="scss" scoped>
.dd-picker-column {
	position: relative;
	flex: 1;
	height: 220px;
	overflow: hidden;
	
	.dd-picker-column-mask {
		position: absolute;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		background: linear-gradient(
			180deg,
			rgba(255, 255, 255, 0.9) 0%,
			rgba(255, 255, 255, 0.4) 40%,
			rgba(255, 255, 255, 0) 50%,
			rgba(255, 255, 255, 0.4) 60%,
			rgba(255, 255, 255, 0.9) 100%
		);
		pointer-events: none;
		z-index: 2;
	}
	
	.dd-picker-column-indicator {
		position: absolute;
		top: 50%;
		left: 0;
		right: 0;
		height: 44px;
		margin-top: -22px;
		pointer-events: none;
		z-index: 3;

		&::before,
		&::after {
			content: '';
			position: absolute;
			left: 0;
			right: 0;
			height: 1px;
			transform: scaleY(0.5);
		}

		&::before {
			top: 0;
			border-top: 1px solid rgba(0, 0, 0, 0.1);
			transform-origin: 0 0;
		}

		&::after {
			bottom: 0;
			border-bottom: 1px solid rgba(0, 0, 0, 0.1);
			transform-origin: 0 100%;
		}
	}
	
	.dd-picker-column-content {
		position: relative;
		padding-top: 88px;
		padding-bottom: 88px;
		cursor: grab;
		
		&:active {
			cursor: grabbing;
		}
	}
	
	.dd-picker-column-item {
		height: 44px;
		line-height: 44px;
		text-align: center;
		font-size: 16px;
		color: #333;
		transition: color 0.3s ease;
		
		&.dd-picker-column-item-selected {
			color: #000;
			font-weight: 500;
		}
	}
}
</style>
