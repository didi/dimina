<script setup>
// 滑块视图容器。其中只可放置swiper-item组件，否则会导致未定义的行为。
// https://developers.weixin.qq.com/miniprogram/dev/component/swiper.html

import { transformRpx } from '@dimina/common'
import { cloneVNode } from 'vue'
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
const slotItems = ref([])
const leadingClonedItems = ref([])
const trailingClonedItems = ref([])
const currentIndex = ref(props.current)

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

function cloneSwiperItems(items, position) {
	return items.map((item, idx) => cloneVNode(item, {
		key: `${position}-${idx}-${item.key ?? idx}`,
		'data-dd-cloned': '',
	}))
}

const swiperSliders = ref(null)
const swiperFrame = ref(null)

let startX = 0
let startY = 0
let isDragging = false
let isPointerDown = false
let directionChecked = false
let containerRect = { width: 0, height: 0 }
let moveX = 0
let moveY = 0
let startTime = 0
let lastPositionX = 0
let lastPositionY = 0
let rafId
let intervalId // 自动播放的定时器ID
let source = ''

const wrapperStyle = ref({
	transform: props.vertical ? `translateY(-${props.current}00%)` : `translateX(-${props.current}00%)`,
	transition: `transform ${props.duration}ms ease`,
	flexDirection: props.vertical ? 'column' : 'row',
})

const wrapperEventStyle = computed(() => {
	return {
		touchAction: props.vertical ? 'pan-x' : 'pan-y',
	}
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

const normalizedDisplayMultipleItems = computed(() => {
	return Math.max(1, Number(props.displayMultipleItems) || 1)
})

const circularEnabled = computed(() => {
	return props.circular && slotCount.value > normalizedDisplayMultipleItems.value
})

const maxCurrent = computed(() => {
	return Math.max(slotCount.value - normalizedDisplayMultipleItems.value, 0)
})

const hasClonedItems = computed(() => {
	return leadingClonedItems.value.length > 0 || trailingClonedItems.value.length > 0
})

function normalizeCurrent(current) {
	const total = slotCount.value
	if (!total) {
		return 0
	}

	const roundedCurrent = Math.round(Number(current) || 0)
	if (circularEnabled.value) {
		return ((roundedCurrent % total) + total) % total
	}

	return Math.min(Math.max(roundedCurrent, 0), maxCurrent.value)
}

function getVisibleCurrent(current = currentIndex.value) {
	return normalizeCurrent(current)
}

function isActiveDot(index) {
	const current = getVisibleCurrent()
	const displayCount = normalizedDisplayMultipleItems.value
	return (current <= index && index < current + displayCount)
		|| index < current + displayCount - slotCount.value
}

function getDotStyle(index) {
	return {
		backgroundColor: isActiveDot(index)
			? props.indicatorActiveColor
			: props.indicatorColor,
	}
}

// 监听插槽内容变化
watchEffect(() => {
	if (slots.default) {
		const slotElements = slots.default()
		const res = findSwiperItems(slotElements)

		slotCount.value = res.length
		slotItems.value = res

		if (circularEnabled.value) {
			leadingClonedItems.value = cloneSwiperItems(res.slice(-normalizedDisplayMultipleItems.value), 'leading')
			trailingClonedItems.value = cloneSwiperItems(res.slice(0, normalizedDisplayMultipleItems.value), 'trailing')
		}
		else {
			leadingClonedItems.value = []
			trailingClonedItems.value = []
		}
	}
	else {
		slotCount.value = 0
		slotItems.value = []
		leadingClonedItems.value = []
		trailingClonedItems.value = []
	}

	if (props.autoplay) {
		startAutoplay()
	}
	else {
		stopAutoplay()
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
	if (directionChecked) {
		if (isDragging && event.cancelable) {
			event.preventDefault()
		}
		return
	}

	const absDeltaX = Math.abs(deltaX)
	const absDeltaY = Math.abs(deltaY)

	if (absDeltaX < 2 && absDeltaY < 2) {
		return
	}

	// 组件是垂直组件
	if (props.vertical) {
		// 在垂直方向滑动距离大于水平方向时才处理为组件滑动
		isDragging = absDeltaX < absDeltaY
		if (isDragging && event.cancelable) {
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

	directionChecked = true
}

function requestMargin() {
	if (!swiperSliders.value || !swiperFrame.value) {
		return
	}

	const previousMargin = props.previousMargin ? transformRpx(props.previousMargin) : ''
	const nextMargin = props.nextMargin ? transformRpx(props.nextMargin) : ''
	const itemSize = `${Math.abs(100 / normalizedDisplayMultipleItems.value)}%`

	if (props.vertical) {
		swiperSliders.value.style.left = 0
		swiperSliders.value.style.right = 0
		swiperSliders.value.style.top = previousMargin
		swiperSliders.value.style.bottom = nextMargin
		swiperFrame.value.style.width = '100%'
		swiperFrame.value.style.height = itemSize
	}
	else {
		swiperSliders.value.style.left = previousMargin
		swiperSliders.value.style.right = nextMargin
		swiperSliders.value.style.top = 0
		swiperSliders.value.style.bottom = 0
		swiperFrame.value.style.height = '100%'
		swiperFrame.value.style.width = itemSize
	}
}

function calcSnapPosition(position) {
	if (
		!props.snapToEdge
		|| circularEnabled.value
		|| slotCount.value < 2
		|| !swiperSliders.value
		|| !swiperFrame.value
	) {
		return position
	}

	const axisOffset = props.vertical ? 'offsetTop' : 'offsetLeft'
	const axisSize = props.vertical ? 'offsetHeight' : 'offsetWidth'
	const frameSize = swiperFrame.value[axisSize] || 1

	if (position === 0 && props.previousMargin) {
		return swiperSliders.value[axisOffset] / frameSize
	}

	if (position === maxCurrent.value && props.nextMargin) {
		const trailingMargin = swiperSliders.value.parentElement[axisSize] - swiperSliders.value[axisOffset] - swiperSliders.value[axisSize]
		return maxCurrent.value - trailingMargin / frameSize
	}

	return position
}

function getTranslatePosition(position, skipSnap = false) {
	const normalizedPosition = hasClonedItems.value ? position + leadingClonedItems.value.length : position
	return skipSnap ? normalizedPosition : calcSnapPosition(normalizedPosition)
}

function applyTransform(position, skipSnap = false) {
	const translateValue = getTranslatePosition(position, skipSnap)
	wrapperStyle.value.transform = `translate${props.vertical ? 'Y' : 'X'}(-${translateValue * 100}%)`
}

function setNewCurrent(newCurrent) {
	if (!circularEnabled.value || (newCurrent !== -1 && newCurrent !== slotCount.value)) {
		newCurrent = normalizeCurrent(newCurrent)
	}
	if (newCurrent === currentIndex.value) {
		return
	}

	currentIndex.value = newCurrent
	updateTransform()

	triggerEvent('change', {
		info,
		detail: {
			current: getVisibleCurrent(newCurrent),
			source,
		},
	})
}

watch(
	[
		() => props.vertical,
		() => props.autoplay,
		() => props.current,
		() => props.previousMargin,
		() => props.nextMargin,
		() => props.circular,
		() => props.displayMultipleItems,
		() => props.snapToEdge,
		() => props.interval,
	],
	([newVertical, newAutoplay, newCurrent, newPreviousMargin, newNextMargin, newCircular, newDisplayMultipleItems, newSnapToEdge, newInterval], [oldVertical, oldAutoplay, _oldCurrent, oldPreviousMargin, oldNextMargin, oldCircular, oldDisplayMultipleItems, oldSnapToEdge, oldInterval]) => {
		if (oldVertical !== newVertical) {
			wrapperStyle.value.flexDirection = newVertical ? 'column' : 'row'
			requestMargin()
			updateTransform()
			wrapperStyle.value.transition = 'none'
		}
		if (oldAutoplay !== newAutoplay || oldInterval !== newInterval) {
			if (newAutoplay) {
				startAutoplay()
			}
			else {
				stopAutoplay()
			}
		}

		if (oldDisplayMultipleItems !== newDisplayMultipleItems) {
			currentIndex.value = normalizeCurrent(currentIndex.value)
			requestMargin()
			updateTransform()
			wrapperStyle.value.transition = 'none'
		}

		// 只有在不是内部变更时才响应current的变化
		if (newCurrent !== currentIndex.value && !isInternalChange) {
			source = ''
			setNewCurrent(newCurrent)
		}

		if (oldPreviousMargin !== newPreviousMargin || newNextMargin !== oldNextMargin || oldSnapToEdge !== newSnapToEdge) {
			requestMargin()
			updateTransform()
			wrapperStyle.value.transition = 'none'
		}

		if (oldCircular !== newCircular) {
			currentIndex.value = normalizeCurrent(currentIndex.value)
			updateTransform()
			wrapperStyle.value.transition = 'none'
		}
	},
)

watch(slotCount, () => {
	if (currentIndex.value !== -1 && currentIndex.value !== slotCount.value) {
		currentIndex.value = normalizeCurrent(currentIndex.value)
	}
	if (swiperFrame.value) {
		applyTransform(currentIndex.value)
		wrapperStyle.value.transition = 'none'
	}
})

function startDrag(event) {
	if (!event.touches && event.button !== 0) {
		return
	}

	isPointerDown = true

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
	directionChecked = false
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
	if (!isPointerDown) {
		return
	}

	moveX = (event.touches ? event.touches[0].clientX : event.clientX) - startX
	moveY = (event.touches ? event.touches[0].clientY : event.clientY) - startY

	// 检查滑动方向，并在同步事件阶段阻止默认滚动
	checkDirection(moveX, moveY, event)

	if (!isDragging) {
		return
	}

	// 使用requestAnimationFrame来优化拖动性能
	if (rafId) {
		cancelAnimationFrame(rafId)
	}

	rafId = requestAnimationFrame(() => {
		let move = props.vertical ? moveY : moveX
		const containerSize = props.vertical ? containerRect.height : containerRect.width

		// 计算当前移动距离相对于容器尺寸的比例
		const moveRatio = move / containerSize

		// 增强跟手感：使用1.1倍的移动距离，让滑动感觉更灵敏
		move = move * 1.1

		if (!circularEnabled.value) {
			const isAtStart = currentIndex.value === 0
			const isAtEnd = currentIndex.value === maxCurrent.value

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
			const offset = getTranslatePosition(currentIndex.value)
			const translateY = -offset * 100 + (move / containerRect.height) * 100
			wrapperStyle.value.transform = `translateY(${translateY}%)`
		}
		else {
			const offset = getTranslatePosition(currentIndex.value)
			const translateX = -offset * 100 + (move / containerRect.width) * 100
			wrapperStyle.value.transform = `translateX(${translateX}%)`
		}
	})
}

function endDrag() {
	if (!isPointerDown) {
		return
	}

	isPointerDown = false
	directionChecked = false
	// 如果没有检测到有效的拖动，直接恢复位置
	if (!isDragging) {
		applyTransform(currentIndex.value)
		startAutoplay()
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
		const isAtEdge = hasClonedItems.value
			? currentIndex.value === -1 || currentIndex.value === slotCount.value
			: currentIndex.value === 0 || currentIndex.value === maxCurrent.value

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
		applyTransform(currentIndex.value)
	}

	// 根据速度和距离来判断是否切换到下一张或上一张
	if (slotCount.value > normalizedDisplayMultipleItems.value) {
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
	const newCurrent = circularEnabled.value
		? currentIndex.value + 1
		: Math.min(currentIndex.value + 1, maxCurrent.value)
	if (newCurrent === currentIndex.value) {
		fallback?.()
		return
	}
	isInternalChange = true
	setNewCurrent(newCurrent)
}

// 切换到上一张
function prevSlide(fallback) {
	const newCurrent = circularEnabled.value
		? currentIndex.value - 1
		: Math.max(currentIndex.value - 1, 0)
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

	if (circularEnabled.value) {
		if (currentIndex.value === slotCount.value) {
			currentIndex.value = 0
			applyTransform(0, true)
			wrapperStyle.value.transition = 'none'
		}
		else if (currentIndex.value === -1) {
			currentIndex.value = slotCount.value - 1
			applyTransform(currentIndex.value, true)
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
			current: getVisibleCurrent(),
			source,
		},
	})
}

// 更新容器的transform样式
function updateTransform() {
	// 确保之前的动画已被取消
	if (rafId) {
		cancelAnimationFrame(rafId)
		rafId = undefined
	}

	if (swiperFrame.value) {
		const rect = swiperFrame.value.getBoundingClientRect()
		lastPositionX = rect.x
		lastPositionY = rect.y
	}

	// 重新设置transform和transition
	applyTransform(currentIndex.value)
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

// 开始自动播放
function startAutoplay() {
	stopAutoplay()
	// 即使启动自动播放开关，数量需要大于同时展示数量才启动自动播放
	if (props.autoplay && slotCount.value > normalizedDisplayMultipleItems.value) {
		intervalId = setInterval(() => {
			if (isDragging) {
				return
			}
			source = 'autoplay'
			isInternalChange = true
			if (circularEnabled.value) {
				setNewCurrent(currentIndex.value + 1)
			}
			else {
				setNewCurrent(currentIndex.value < maxCurrent.value ? currentIndex.value + 1 : 0)
			}
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
	currentIndex.value = normalizeCurrent(currentIndex.value)
	applyTransform(currentIndex.value)
	wrapperStyle.value.transition = 'none'
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
			class="dd-swiper-wrapper" :style="wrapperEventStyle"
			:aria-label="Boolean(props.vertical) ? '可竖向滚动' : '可横向滚动'" @touchstart="startDrag"
			@touchmove="drag" @touchend="endDrag" @touchcancel="endDrag" @mousedown="startDrag"
			@mousemove="drag" @mouseup="endDrag" @mouseleave="endDrag"
		>
			<div ref="swiperSliders" class="dd-swiper-slides">
				<div
					ref="swiperFrame" class="dd-swiper-slide-frame" :style="wrapperStyle"
					@transitionend="handleTransitionEnd"
				>
					<!-- 插入克隆的最后几个元素 -->
					<template v-if="leadingClonedItems.length">
						<component
							:is="clonedItem" v-for="(clonedItem, idx) in leadingClonedItems"
							:key="`leading-${idx}`" data-dd-cloned
						/>
					</template>

					<slot />

					<!-- 插入克隆的前几个元素 -->
					<template v-if="trailingClonedItems.length">
						<component
							:is="clonedItem" v-for="(clonedItem, idx) in trailingClonedItems"
							:key="`trailing-${idx}`" data-dd-cloned
						/>
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
					v-for="idx in slotCount" :key="idx" :data-dot-index="idx - 1" class="dd-swiper-dot"
					:class="{ 'dd-swiper-dot-active': isActiveDot(idx - 1) }"
					:style="getDotStyle(idx - 1)"
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
