<script setup>
// 滑块视图容器。其中只可放置swiper-item组件，否则会导致未定义的行为。
// https://developers.weixin.qq.com/miniprogram/dev/component/swiper.html

import { triggerEvent, useInfo } from '@/common/events'

const props = defineProps({
	/**
	 * 是否显示面板指示点
	 */
	indicatorDots: {
		type: Boolean,
		default: false,
	},
	/**
	 * 指示点颜色
	 */
	indicatorColor: {
		type: String,
		default: 'rgba(0, 0, 0, .3)',
	},
	/**
	 * 当前选中的指示点颜色
	 */
	indicatorActiveColor: {
		type: String,
		default: '#000000',
	},
	/**
	 * 是否自动切换
	 */
	autoplay: {
		type: Boolean,
		default: false,
	},
	/**
	 * 当前所在滑块的 index
	 */
	current: {
		type: Number,
		default: 0,
	},
	/**
	 * 自动切换时间间隔
	 */
	interval: {
		type: Number,
		default: 5000,
	},
	/**
	 * 滑动动画时长
	 */
	duration: {
		type: Number,
		default: 500,
	},
	/**
	 * 是否衔接滑动(循环滚动)
	 */
	circular: {
		type: Boolean,
		default: false,
	},
	/**
	 * 滑动方向是否为纵向
	 */
	vertical: {
		type: Boolean,
		default: false,
	},
	/**
	 * 同时显示的滑块数量
	 */
	displayMultipleItems: {
		type: Number,
		default: 1,
	},
	/**
	 * 前边距，可用于露出前一项的一小部分，接受 px 和 rpx 值
	 */
	previousMargin: {
		type: String,
		default: '0px',
	},
	/**
	 * 指定 swiper 切换缓动动画类型
	 * default	默认缓动函数
	 * linear	线性动画
	 * easeInCubic	缓入动画
	 * easeOutCubic	缓出动画
	 * easeInOutCubic	缓入缓出动画
	 */
	easingFunction: {
		type: String,
		default: 'default',
		validator: (value) => {
			return ['default', 'linear', 'easeInCubic', 'easeOutCubic', 'easeInOutCubic'].includes(value)
		},
	},
	/**
	 * 后边距，可用于露出后一项的一小部分，接受 px 和 rpx 值
	 */
	nextMargin: {
		type: String,
		default: '0px',
	},
	/**
	 * 当 swiper-item 的个数大于等于 2，关闭 circular 并且开启 previous-margin 或 next-margin 的时候，可以指定这个边距是否应用到第一个、最后一个元素
	 */
	snapToEdge: {
		type: Boolean,
		default: false,
	},
})

const info = useInfo()

const slots = useSlots()
const slotCount = ref(0)
const clonedItems = ref([])
const realSlotCount = ref(0)

// 添加标记来追踪内部变更
let isInternalChange = false

// 递归查找所有子节点中是 Swiper-Item 的节点数量
function findSwiperItems(nodes) {
	const res = []
	for (let i = 0; i < nodes.length; i++) {
		const vnode = nodes[i]
		if (vnode.type?.__name === 'SwiperItem') {
			res.push(vnode)
		}
		else if (vnode.children) {
			// 如果当前节点有子节点，则递归查找
			res.push(...findSwiperItems(vnode.children.default ? vnode.children.default() : vnode.children))
		}
	}

	return res
}

// 监听插槽内容变化
watchEffect(() => {
	// 获取插槽中子节点的数量作为指示点数量
	if (slots.default) {
		const slotElements = slots.default()
		const res = findSwiperItems(slotElements)

		slotCount.value = res.length

		if (props.circular && res.length > 1) {
			clonedItems.value = [
				res[res.length - 1], // 克隆最后一个元素到最前面
				res[0], // 克隆第一个元素到最后面
			]
			realSlotCount.value = slotCount.value + 2
		}
		else {
			clonedItems.value = []
			realSlotCount.value = slotCount.value
		}
	}
	else {
		slotCount.value = 0
		realSlotCount.value = 0
	}
})

const currentIndex = ref(props.current)

const swiperSliders = ref(null)
const swiperFrame = ref(null)

let startX = 0
let startY = 0
let isDragging = false
let containerRect = { width: 0, height: 0 }
let moveX = 0
let moveY = 0
let startTime = 0
let lastPositionX = 0
let lastPositionY = 0
let rafId
let source = ''

const wrapperStyle = ref({
	transform: props.vertical ? `translateY(-${props.current}00%)` : `translateX(-${props.current}00%)`,
	transition: `transform ${props.duration}ms ease`,
	flexDirection: props.vertical ? 'column' : 'row',
})

const easingParsed = computed(() => {
	switch (props.easingFunction) {
		case 'linear':
			return 'linear'
		case 'easeInCubic':
			return 'ease-in'
		case 'easeOutCubic':
			return 'ease-out'
		case 'easeInOutCubic':
			return 'ease-in-out'
		default:
			return 'ease-in'
	}
})

// 计算滑动速度和方向
function getVelocity(distance, time) {
	// 使用指数衰减模型来计算速度，更接近原生物理效果
	const velocity = distance / Math.max(time, 16) // 最小 16ms (60fps)
	// 对于快速滑动，使用幂函数增强效果，让快速滑动更有动力感
	const enhancedVelocity = Math.sign(velocity) * (Math.abs(velocity) ** 1.05)
	return enhancedVelocity
}

// 方向检测函数
function checkDirection(deltaX, deltaY, event) {
	const absDeltaX = Math.abs(deltaX)
	const absDeltaY = Math.abs(deltaY)

	// 组件是垂直组件
	if (props.vertical) {
		// 在垂直方向滑动距离大于水平方向时才处理为组件滑动
		isDragging = absDeltaX < absDeltaY
		// 在垂直模式下，如果事件可以取消，始终阻止默认滚动行为
		if (event.cancelable) {
			event.preventDefault()
		}
	}
	else {
		// 组件是水平组件，在水平方向滑动距离大于垂直方向时才处理为组件滑动
		isDragging = absDeltaX > absDeltaY
		if (isDragging && absDeltaX > absDeltaY && event.cancelable) {
			// 用户水平方向滑动距离大于垂直方向，用户在组件内滑动且方向与组件滑动方向一致,阻止页面默认滚动行为
			event.preventDefault()
		}
	}
}

function requestMargin() {
	if (props.vertical) {
		swiperSliders.value.style.left = 0
		swiperSliders.value.style.right = 0
		swiperSliders.value.style.top = props.previousMargin
		swiperSliders.value.style.bottom = props.nextMargin
		swiperFrame.value.style.width = '100%'
		swiperFrame.value.style.height = `${Math.abs(100 / props.displayMultipleItems)}%`
	}
	else {
		swiperSliders.value.style.left = props.previousMargin
		swiperSliders.value.style.right = props.nextMargin
		swiperSliders.value.style.top = 0
		swiperSliders.value.style.bottom = 0
		swiperFrame.value.style.height = '100%'
		swiperFrame.value.style.width = `${Math.abs(100 / props.displayMultipleItems)}%`
	}
}

function setNewCurrent(newCurrent) {
	if (newCurrent === currentIndex.value) {
		return
	}

	currentIndex.value = newCurrent
	updateTransform()

	const maxLength = clonedItems.value.length ? realSlotCount.value - 2 : realSlotCount.value

	triggerEvent('change', {
		info,
		detail: {
			current: (newCurrent + maxLength) % maxLength,
			source,
		},
	})
}

watch(
	[() => props.vertical, () => props.autoplay, () => props.current, () => props.previousMargin, () => props.nextMargin, () => props.circular],
	([newVertical, newAutoplay, newCurrent, newPreviousMargin, newNextMargin, newCircular], [oldVertical, oldAutoplay, _oldCurrent, oldPreviousMargin, oldNextMargin, oldCircular]) => {
		if (oldVertical !== newVertical) {
			wrapperStyle.value.flexDirection = newVertical ? 'column' : 'row'
			updateTransform()
			wrapperStyle.value.transition = 'none'
		}
		if (oldAutoplay !== newAutoplay) {
			if (newAutoplay) {
				startAutoplay()
			}
			else {
				stopAutoplay()
			}
		}

		// 只有在不是内部变更时才响应current的变化
		if (newCurrent !== currentIndex.value && !isInternalChange) {
			source = ''
			setNewCurrent(newCurrent)
		}

		if (oldPreviousMargin !== newPreviousMargin || newNextMargin !== oldNextMargin) {
			requestMargin()
		}

		if (oldCircular !== newCircular) {
			if (clonedItems.value.length) {
				let newCurrent = currentIndex.value + 1
				if (newCurrent >= slotCount.value) {
					newCurrent = 1
				}
				if (props.vertical) {
					wrapperStyle.value.transform = `translateY(-${newCurrent}00%)`
				}
				else {
					wrapperStyle.value.transform = `translateX(-${newCurrent}00%)`
				}
				wrapperStyle.value.transition = 'none'
			}
			else {
				let newCurrent = currentIndex.value - 1
				if (newCurrent < 0) {
					newCurrent = 0
				}
				if (props.vertical) {
					wrapperStyle.value.transform = `translateY(${newCurrent}00%)`
				}
				else {
					wrapperStyle.value.transform = `translateX(${newCurrent}00%)`
				}
				wrapperStyle.value.transition = 'none'
			}
		}
	},
)

function startDrag(event) {
	// 拖动时，禁止自动播放
	stopAutoplay()

	// 立即中断当前动画
	if (rafId) {
		cancelAnimationFrame(rafId)
		rafId = undefined
	}

	// 检查是否在过渡动画中，如果是则强制结束过渡
	if (wrapperStyle.value.transition && wrapperStyle.value.transition !== 'none') {
		// 强制触发 transitionend 事件处理
		handleTransitionEnd({ type: 'transitionend' })
	}

	// 重置transition以立即响应
	wrapperStyle.value.transition = 'none'

	startTime = Date.now()
	isDragging = false // 重置为 false，等待 checkDirection 判断
	startX = event.touches ? event.touches[0].clientX : event.clientX
	startY = event.touches ? event.touches[0].clientY : event.clientY
	moveX = 0
	moveY = 0
	containerRect = {
		width: swiperFrame.value.offsetWidth,
		height: swiperFrame.value.offsetHeight,
	}
	const rect = swiperFrame.value.getBoundingClientRect()
	lastPositionX = rect.x
	lastPositionY = rect.y
}

function drag(event) {
	// 使用requestAnimationFrame来优化拖动性能
	if (rafId) {
		cancelAnimationFrame(rafId)
	}

	// 在垂直模式下，始终阻止默认滚动行为，防止页面滚动
	if (props.vertical && event.cancelable) {
		event.preventDefault()
	}

	rafId = requestAnimationFrame(() => {
		// 获取最新的触摸位置
		moveX = (event.touches ? event.touches[0].clientX : event.clientX) - startX
		moveY = (event.touches ? event.touches[0].clientY : event.clientY) - startY

		// 检查滑动方向
		checkDirection(moveX, moveY, event)

		if (!isDragging) {
			return
		}

		let move = props.vertical ? moveY : moveX
		const containerSize = props.vertical ? containerRect.height : containerRect.width

		// 计算当前移动距离相对于容器尺寸的比例
		const moveRatio = move / containerSize

		// 增强跟手感：使用1.1倍的移动距离，让滑动感觉更灵敏
		move = move * 1.1

		if (props.circular) {
			const isAtStart = currentIndex.value === 0
			const isAtEnd = currentIndex.value === (clonedItems.value.length ? realSlotCount.value - 3 : realSlotCount.value - 1)

			// 优化阻尼效果：使用更平滑的非线性函数
			if ((isAtStart && move > 0) || (isAtEnd && move < 0)) {
				// 使用更平滑的阻尼曲线，让边缘拖动感觉更自然
				const dampingFactor = Math.abs(moveRatio)
				const dampingCurve = 0.6 - 0.3 / (dampingFactor + 0.8) // 更平滑的曲线
				move = move * dampingCurve
			}
		}

		// 计算精确的位移百分比，使用更精确的计算方式
		if (props.vertical) {
			const offset = currentIndex.value + (clonedItems.value.length ? 1 : 0)
			const translateY = -offset * 100 + (move / containerRect.height) * 100
			wrapperStyle.value.transform = `translateY(${translateY}%)`
		}
		else {
			const offset = currentIndex.value + (clonedItems.value.length ? 1 : 0)
			const translateX = -offset * 100 + (move / containerRect.width) * 100
			wrapperStyle.value.transform = `translateX(${translateX}%)`
		}
	})
}

function endDrag() {
	// 如果没有检测到有效的拖动，直接恢复位置
	if (!isDragging) {
		const transVal = currentIndex.value + (clonedItems.value.length ? 1 : 0)
		wrapperStyle.value.transform = `translate${props.vertical ? 'Y' : 'X'}(-${transVal}00%)`
		return
	}

	// 计算拖动时间和速度
	const elapsedTime = Date.now() - startTime

	// 确保任何进行中的动画帧被取消
	if (rafId) {
		cancelAnimationFrame(rafId)
		rafId = undefined
	}

	const move = props.vertical ? moveY : moveX

	// 如果没有实际移动，直接恢复自动播放并返回
	if (move === 0) {
		isDragging = false
		startAutoplay()
		return
	}

	// 计算滑动速度，用于决定是否切换到下一张
	const velocity = getVelocity(move, elapsedTime)

	// 降低速度阈值，让轻微的滑动也能触发切换，提高响应性
	const VELOCITY_THRESHOLD = 0.15

	// 增加距离阈值，让足够距离的拖动也能触发切换，即使速度不够
	const DISTANCE_THRESHOLD = 0.15 // 容器宽度的15%
	const containerSize = props.vertical ? containerRect.height : containerRect.width
	const moveRatio = Math.abs(move) / containerSize

	// 回弹函数，使用更平滑的动画
	const fallback = () => {
		// 确保过渡动画已设置，使用更平滑的缓动效果
		// 考虑克隆项目情况下的边缘检测
		const isAtEdge = clonedItems.value.length
			? currentIndex.value === -1 || currentIndex.value === (realSlotCount.value - 2)
			: currentIndex.value === 0 || currentIndex.value === (slotCount.value - 1)

		// 同时考虑拖动速度和距离来调整回弹时间
		// 拖动速度越快或距离越大，回弹时间越短
		const velocityFactor = Math.min(Math.max(Math.abs(velocity) * 2.5, 0.6), 2.0)
		const distanceFactor = Math.min(Math.max(moveRatio * 1.8, 0.5), 1.5)
		// 综合速度和距离因素，使动画更自然
		const combinedFactor = (velocityFactor * 0.7 + distanceFactor * 0.3)
		// 限制回弹时间的范围，确保快速回弹但不会过快
		const adjustedDuration = Math.max(Math.min(Math.round(props.duration / combinedFactor), props.duration), 150)

		// 选择更适合的缓动曲线，根据速度和距离动态调整
		let dynamicEasing
		if (Math.abs(velocity) > 0.5 || moveRatio > 0.3) {
			// 快速滑动或大距离拖动使用弹性曲线
			dynamicEasing = 'cubic-bezier(0.175, 0.885, 0.32, 1.275)' // 弹性曲线，模拟弹簧效果
		}
		else if (isAtEdge) {
			// 在边缘使用特殊的曲线
			dynamicEasing = 'cubic-bezier(0.34, 1.56, 0.64, 1)'
		}
		else {
			// 其他情况使用标准缓动
			dynamicEasing = easingParsed.value
		}

		wrapperStyle.value.transition = `transform ${adjustedDuration}ms ${dynamicEasing}`

		// 更新transform，与updateTransform保持一致
		const translateValue = currentIndex.value + (clonedItems.value.length ? 1 : 0)
		wrapperStyle.value.transform = `translate${props.vertical ? 'Y' : 'X'}(-${translateValue}00%)`
	}

	// 根据速度和距离来判断是否切换到下一张或上一张
	if (slotCount.value > 1) {
		// 如果是手动拖动且速度足够快或拖动距离足够大，直接切换
		if (Math.abs(velocity) > VELOCITY_THRESHOLD || moveRatio > DISTANCE_THRESHOLD) {
			// 根据拖动速度动态调整动画时间，拖动越快动画越快
			// 进一步增强速度因子的影响，使速度对动画时间的影响更明显
			// 增大速度系数和上限，让快速滑动效果更明显
			const speedFactor = Math.min(Math.max(Math.abs(velocity) * 3.5, 0.8), 4.0)
			const distanceFactor = Math.min(Math.max(moveRatio * 1.8, 0.6), 1.8)
			// 给速度因子更大的权重，使得拖动速度对动画时间的影响更大
			const combinedFactor = (speedFactor * 0.8 + distanceFactor * 0.2)
			// 快速滑动时使用更短的动画时间，最小可以到100ms
			const newDuration = Math.max(Math.min(Math.round(props.duration / combinedFactor), props.duration), 100)

			// 选择更适合的缓动曲线，根据速度动态调整
			let dynamicEasing
			if (Math.abs(velocity) > 0.8) {
				// 快速滑动使用更加线性的曲线，模拟惯性
				dynamicEasing = 'cubic-bezier(0.25, 0.1, 0.25, 1.0)'
			}
			else {
				// 使用默认缓动曲线
				dynamicEasing = easingParsed.value
			}
			// 设置过渡效果，使用动态缓动曲线
			wrapperStyle.value.transition = `transform ${newDuration}ms ${dynamicEasing}`

			source = 'touch'
			// 根据方向决定是前进还是后退
			if (move > 0) {
				prevSlide(fallback)
			}
			else {
				nextSlide(fallback)
			}
		}
		else {
			// 回到原位，但使用动态计算的持续时间
			fallback()
		}
	}
	else {
		fallback()
	}

	isDragging = false
	startAutoplay()
}

// 切换到下一张
function nextSlide(fallback) {
	const newCurrent = Math.min(currentIndex.value + 1, clonedItems.value.length ? realSlotCount.value - 2 : realSlotCount.value - 1)
	if (newCurrent === currentIndex.value) {
		fallback?.()
		return
	}
	isInternalChange = true
	setNewCurrent(newCurrent)
}

// 切换到上一张
function prevSlide(fallback) {
	const newCurrent = Math.max(currentIndex.value - 1, clonedItems.value.length ? -1 : 0)
	if (newCurrent === currentIndex.value) {
		fallback?.()
		return
	}
	isInternalChange = true
	setNewCurrent(newCurrent)
}

function handleTransitionEnd(event) {
	// 动画结束时重置内部变更标记
	isInternalChange = false

	if (props.circular && slotCount.value > 1) {
		if (currentIndex.value === slotCount.value) {
			currentIndex.value = 0
			wrapperStyle.value.transform = props.vertical ? 'translateY(-100%)' : 'translateX(-100%)'
			wrapperStyle.value.transition = 'none'
		}
		else if (currentIndex.value === -1) {
			currentIndex.value = slotCount.value - 1
			wrapperStyle.value.transform = props.vertical ? `translateY(-${slotCount.value}00%)` : `translateX(-${slotCount.value}00%)`
			wrapperStyle.value.transition = 'none'
		}
	}

	if (rafId) {
		cancelAnimationFrame(rafId)
		rafId = undefined
	}

	triggerEvent('animationfinish', {
		event,
		info,
		detail: {
			current: currentIndex.value,
			source,
		},
	})
}

// 更新容器的transform样式
function updateTransform() {
	let translateValue = currentIndex.value
	if (clonedItems.value.length) {
		translateValue += 1 // 因为我们添加了一个克隆的 slide 在开头
	}

	// 确保之前的动画已被取消
	if (rafId) {
		cancelAnimationFrame(rafId)
		rafId = undefined
	}

	// 重新设置transform和transition
	if (props.vertical) {
		wrapperStyle.value.transform = `translateY(-${translateValue}00%)`
	}
	else {
		wrapperStyle.value.transform = `translateX(-${translateValue}00%)`
	}
	wrapperStyle.value.transition = `transform ${props.duration}ms ${easingParsed.value}`
	// 开始监听动画
	rafId = requestAnimationFrame(monitorAnimation)
}

// 动画过程监听函数
function monitorAnimation() {
	if (rafId) {
		cancelAnimationFrame(rafId)
		rafId = undefined
	}

	const rect = swiperFrame.value.getBoundingClientRect()

	if (props.vertical) {
		const dy = lastPositionY - rect.y
		triggerEvent('transition', {
			info,
			detail: {
				dx: 0,
				dy,
			},
		})
	}
	else {
		const dx = lastPositionX - rect.x
		triggerEvent('transition', {
			info,
			detail: {
				dx,
				dy: 0,
			},
		})
	}
}

let intervalId // 自动播放的定时器ID
// 开始自动播放
function startAutoplay() {
	// 即使启动自动播放开关，数量需要大于1才启动自动播放
	if (props.autoplay && slotCount.value > 1) {
		stopAutoplay()
		intervalId = setInterval(() => {
			if (isDragging) {
				return
			}
			source = 'autoplay'
			nextSlide()
		}, props.interval)
	}
}

// 停止自动播放
function stopAutoplay() {
	if (intervalId) {
		clearInterval(intervalId)
		intervalId = null
	}
}

onMounted(() => {
	requestMargin()
	if (clonedItems.value.length) {
		updateTransform()
		wrapperStyle.value.transition = 'none'
	}
	startAutoplay() // 组件挂载后开始自动播放
})

onBeforeUnmount(() => {
	stopAutoplay() // 组件卸载时停止自动播放
	cancelAnimationFrame(rafId)
	rafId = null
})
</script>

<template>
	<div v-bind="$attrs" class="dd-swiper">
		<div
			class="dd-swiper-wrapper" :aria-label="Boolean(props.vertical) ? '可竖向滚动' : '可横向滚动'" @touchstart="startDrag"
			@touchmove="drag" @touchend="endDrag" @touchcancel="endDrag" @mousedown="startDrag" @mousemove="drag"
			@mouseup="endDrag" @mouseleave="endDrag"
		>
			<div ref="swiperSliders" class="dd-swiper-slides">
				<div
					ref="swiperFrame" class="dd-swiper-slide-frame" :style="wrapperStyle"
					@transitionend="handleTransitionEnd"
				>
					<!-- 插入克隆的最后一个元素 -->
					<template v-if="clonedItems.length">
						<component :is="clonedItems[0]" data-dd-cloned />
					</template>

					<slot />

					<!-- 插入克隆的第一个元素 -->
					<template v-if="clonedItems.length">
						<component :is="clonedItems[1]" data-dd-cloned />
					</template>
				</div>
			</div>
			<div
				v-if="Boolean(props.indicatorDots) && slotCount > 0" class="dd-swiper-dots" :class="{
					'dd-swiper-dots-horizontal': !Boolean(props.vertical),
					'dd-swiper-dots-vertical': Boolean(props.vertical),
				}"
			>
				<div
					v-for="idx in slotCount" :key="idx" :data-dot-index="idx" class="dd-swiper-dot"
					:class="{ 'dd-swiper-dot-active': (idx - 1) === currentIndex }"
				/>
			</div>
		</div>
	</div>
</template>

<style lang="scss">
.dd-swiper {
	display: block;
	height: 150px;

	&[hidden] {
		display: none;
	}

	.dd-swiper-wrapper {
		overflow: hidden;
		position: relative;
		width: 100%;
		height: 100%;
		cursor: grab;
	}

	.dd-swiper-slides {
		position: absolute;
		left: 0;
		top: 0;
		right: 0;
		bottom: 0;
	}

	.dd-swiper-slide-frame {
		display: flex;
		position: absolute;
		left: 0;
		top: 0;
		width: 100%;
		height: 100%;
		will-change: transform;
	}

	.dd-swiper-dots {
		position: absolute;
		font-size: 0;
	}

	.dd-swiper-dots-horizontal {
		left: 50%;
		bottom: 10px;
		text-align: center;
		white-space: nowrap;
		transform: translate(-50%, 0);
	}

	.dd-swiper-dots-horizontal .dd-swiper-dot {
		margin-right: 8px;
	}

	.dd-swiper-dots-horizontal .dd-swiper-dot:last-child {
		margin-right: 0;
	}

	.dd-swiper-dots-vertical {
		right: 10px;
		top: 50%;
		text-align: right;
		transform: translate(0, -50%);
	}

	.dd-swiper-dots-vertical .dd-swiper-dot {
		display: block;
		margin-bottom: 9px;
	}

	.dd-swiper-dots-vertical .dd-swiper-dot:last-child {
		margin-bottom: 0;
	}

	.dd-swiper-dot {
		display: inline-block;
		width: 8px;
		height: 8px;
		transition-property: background-color;
		transition-timing-function: ease;
		background: rgba(0, 0, 0, 0.3);
		border-radius: 50%;
	}

	.dd-swiper-dot-active {
		background-color: #000000;
	}
}
</style>
