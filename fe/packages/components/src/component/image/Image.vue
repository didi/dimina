<script setup>
// https://developers.weixin.qq.com/miniprogram/dev/component/image.html
import { hasEvent, triggerEvent, useInfo } from '@/common/events'
import { useTapEvents } from '@/common/useTapEvents'
import { useTouchEvents } from '@/common/useTouchEvents'

const props = defineProps({
	src: {
		type: String,
		default: '',
	},
	lazyLoad: {
		type: Boolean,
		default: false,
	},
	lazyLoadMargin: {
		type: Number,
		default: 2,
	},
	webp: {
		type: Boolean,
		default: false,
	},
	backgroundSize: {
		type: String,
		default: '100% 100%',
	},
	backgroundPosition: {
		type: String,
		default: '',
	},
	backgroundRepeat: {
		type: String,
		default: 'no-repeat',
	},
	renderingMode: {
		type: String,
		default: 'backgroundImage',
		validator: value => ['backgroundImage', 'img'].includes(value),
	},
	showMenuByLongpress: {
		type: Boolean,
		default: false,
	},
	referrerPolicy: {
		type: String,
		default: 'unsafe-url',
	},
	mode: {
		type: String,
		default: 'scaleToFill',
		validator: (val) => {
			return ['scaleToFill', 'aspectFit', 'aspectFill', 'widthFix', 'heightFix', 'top', 'bottom', 'center', 'left', 'right', 'top left', 'top right', 'bottom left', 'bottom right'].includes(val)
		},
	},
})

const MODE_CLASS_MAP = {
	'scaleToFill': 'dd-image-scale',
	'aspectFit': 'dd-image-aspect',
	'aspectFill': 'dd-image-fill',
	'widthFix': 'dd-image-width',
	'heightFix': 'dd-image-height',
	'top': 'dd-image-top',
	'bottom': 'dd-image-bottom',
	'center': 'dd-image-center',
	'left': 'dd-image-left',
	'right': 'dd-image-right',
	'top left': 'dd-image-top-left',
	'top right': 'dd-image-top-right',
	'bottom left': 'dd-image-bottom-left',
	'bottom right': 'dd-image-bottom-right',
}

const dynamicClass = computed(() => MODE_CLASS_MAP[props.mode] || '')

const BACKGROUND_MODE_MAP = {
	'scaleToFill': { backgroundSize: '100% 100%' },
	'aspectFit': { backgroundSize: 'contain', backgroundPosition: 'center center' },
	'aspectFill': { backgroundSize: 'cover', backgroundPosition: 'center center' },
	'widthFix': { backgroundSize: '100% 100%' },
	'heightFix': { backgroundSize: '100% 100%' },
	'top': { backgroundPosition: 'top center' },
	'bottom': { backgroundPosition: 'bottom center' },
	'center': { backgroundPosition: 'center center' },
	'left': { backgroundPosition: 'center left' },
	'right': { backgroundPosition: 'center right' },
	'top left': { backgroundPosition: 'top left' },
	'top right': { backgroundPosition: 'top right' },
	'bottom left': { backgroundPosition: 'bottom left' },
	'bottom right': { backgroundPosition: 'bottom right' },
}

const backgroundStyle = computed(() => {
	if (props.renderingMode !== 'backgroundImage') return undefined
	return {
		backgroundImage: renderedSrc.value ? `url(${JSON.stringify(renderedSrc.value)})` : '',
		backgroundSize: props.backgroundSize,
		backgroundPosition: props.backgroundPosition,
		backgroundRepeat: props.backgroundRepeat,
		...BACKGROUND_MODE_MAP[props.mode],
	}
})

const imgRef = ref(null)
const conRef = ref(null)
const renderedSrc = ref(props.lazyLoad ? '' : props.src)
let intersectionObserver
let resizeObserver
let originalWidth = ''
let originalHeight = ''
let hasBeenShown = !props.lazyLoad

const info = useInfo()
let lastCompletedSrc = ''

onMounted(() => {
	originalWidth = conRef.value.style.width
	originalHeight = conRef.value.style.height
	applyModeSize()
	setupLazyLoading()
	if (window.ResizeObserver && conRef.value) {
		resizeObserver = new ResizeObserver(updateFixedSize)
		resizeObserver.observe(conRef.value)
	}
	checkCompletedImage()
})

onBeforeUnmount(() => {
	intersectionObserver?.disconnect()
	resizeObserver?.disconnect()
})

watch(
	() => props.src,
	async () => {
		lastCompletedSrc = ''
		if (props.lazyLoad) {
			hasBeenShown = false
			renderedSrc.value = ''
			await nextTick()
			setupLazyLoading()
		}
		else {
			showImage()
		}
		await nextTick()
		checkCompletedImage()
	},
)

function showImage() {
	hasBeenShown = true
	renderedSrc.value = props.src
	intersectionObserver?.disconnect()
	intersectionObserver = undefined
}

function setupLazyLoading() {
	intersectionObserver?.disconnect()
	intersectionObserver = undefined
	if (!props.lazyLoad || hasBeenShown || !('IntersectionObserver' in window)) {
		showImage()
		return
	}
	const margin = Math.max(Number(props.lazyLoadMargin) || 0, 0)
	const verticalMargin = margin * window.innerHeight
	const horizontalMargin = margin * window.innerWidth
	intersectionObserver = new IntersectionObserver((entries) => {
		if (entries.some(entry => entry.isIntersecting || entry.intersectionRatio > 0)) showImage()
	}, { rootMargin: `${verticalMargin}px ${horizontalMargin}px` })
	intersectionObserver.observe(conRef.value)
}

watch(
	() => [props.lazyLoad, props.lazyLoadMargin],
	([lazyLoad], [previousLazyLoad]) => {
		if (!lazyLoad) showImage()
		else if (!previousLazyLoad && renderedSrc.value) hasBeenShown = true
		else setupLazyLoading()
	},
)

function handleLoaded(event) {
	lastCompletedSrc = props.src
	updateFixedSize()
	triggerEvent('load', {
		event,
		info,
		detail: {
			width: imgRef.value?.naturalWidth || imgRef.value?.width,
			height: imgRef.value?.naturalHeight || imgRef.value?.height,
		},
	})
}

function updateFixedSize() {
	const image = imgRef.value
	const container = conRef.value
	if (!image?.naturalWidth || !image?.naturalHeight || !container) return
	const ratio = image.naturalWidth / image.naturalHeight
	if (props.mode === 'widthFix') container.style.height = `${container.clientWidth / ratio}px`
	else if (props.mode === 'heightFix') container.style.width = `${container.clientHeight * ratio}px`
}

function applyModeSize() {
	if (!conRef.value) return
	conRef.value.style.width = props.mode === 'heightFix' ? 'auto' : originalWidth
	conRef.value.style.height = props.mode === 'widthFix' ? 'auto' : originalHeight
	nextTick(updateFixedSize)
}

watch(() => props.mode, applyModeSize)

function checkCompletedImage() {
	const img = imgRef.value
	if (!img || !props.src || !img.complete || img.naturalWidth <= 0 || lastCompletedSrc === props.src) {
		return
	}

	handleLoaded(new Event('load'))
}

function handleError(event) {
	triggerEvent('error', {
		event,
		info,
		detail: {
			errMsg: props.src,
		},
	})
}

function handleContextMenu(event) {
	if (!props.showMenuByLongpress) event.preventDefault()
}

// 判断是否有tap事件属性
const hasTapEvent = hasEvent(info, 'tap')
if (hasTapEvent) {
	useTapEvents(conRef, (event) => {
		triggerEvent('tap', { event, info })
	})
}

// 判断是否有触摸相关事件属性
const hasTouchEvents = hasEvent(info, 'touchstart') || hasEvent(info, 'touchmove')
	|| hasEvent(info, 'touchend') || hasEvent(info, 'touchcancel')
	|| hasEvent(info, 'longpress') || hasEvent(info, 'longtap')

// 只有当存在触摸相关事件属性时，才使用触摸事件处理逻辑
if (hasTouchEvents) {
	useTouchEvents(info, conRef)
}
</script>

<template>
<span ref="conRef" v-bind="$attrs" class="dd-image" :style="backgroundStyle" @contextmenu="handleContextMenu">
		<img
			ref="imgRef" :class="[dynamicClass, { 'dd-image-preloader': renderingMode === 'backgroundImage' }]" :src="renderedSrc" alt="" decoding="async"
			:loading="props.lazyLoad ? 'lazy' : 'eager'" :referrerpolicy="referrerPolicy" @load="handleLoaded"
			@error="handleError"
		/>
	</span>
</template>

<style lang="scss">
.dd-image {
	display: inline-block;
	width: 320px;
	height: 240px;
	overflow: hidden;
	background-repeat: no-repeat;
	img {
		width: inherit;
		height: inherit;
		pointer-events: none; // 不会响应点击事件，事件将直接传递到 span 元素，防止 target/currentTarget 为 img 元素
		&[src=''],
		&:not([src]) {
			opacity: 0; /* 隐藏没有src或src为空的图片 */
		}
	}

	&[hidden] {
		display: none;
	}
}

.dd-image-preloader {
	opacity: 0;
}

.dd-image-scale {
	width: 100%;
	height: 100%;
	object-fit: fill;
}

.dd-image-aspect {
	width: 100%;
	height: 100%;
	object-fit: contain;
}

.dd-image-fill {
	width: 100%;
	height: 100%;
	object-fit: cover;
}

.dd-image-width {
	width: 100%;
	height: auto;
}

.dd-image-height {
	width: auto;
	height: 100%;
}

.dd-image-top {
	width: 100%;
	height: 100%;
	object-fit: none;
	object-position: top;
}

.dd-image-bottom {
	width: 100%;
	height: 100%;
	object-fit: none;
	object-position: bottom;
}

.dd-image-center {
	width: 100%;
	height: 100%;
	object-fit: none;
	object-position: center;
}

.dd-image-left {
	width: 100%;
	height: 100%;
	object-fit: none;
	object-position: left;
}

.dd-image-right {
	width: 100%;
	height: 100%;
	object-fit: none;
	object-position: right;
}

.dd-image-top-left {
	width: 100%;
	height: 100%;
	object-fit: none;
	object-position: top left;
}

.dd-image-top-right {
	width: 100%;
	height: 100%;
	object-fit: none;
	object-position: top right;
}

.dd-image-bottom-left {
	width: 100%;
	height: 100%;
	object-fit: none;
	object-position: bottom left;
}

.dd-image-bottom-right {
	width: 100%;
	height: 100%;
	object-fit: none;
	object-position: bottom right;
}
</style>
