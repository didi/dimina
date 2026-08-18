<script setup>
// 系统相机
// https://developers.weixin.qq.com/miniprogram/dev/component/camera.html
import { isAndroid, isDesktop, isHarmonyOS, isIOS } from '@dimina/common'
import { invokeAPI, onEvent, triggerEvent, useInfo } from '@/common/events'
import { ensureNativeLayerTouchBridge } from '@/common/nativeLayerTouchBridge'

const props = defineProps({
	id: { type: String, default: () => `camera-${useId()}` },
	mode: {
		type: String,
		default: 'normal',
		validator: value => ['normal', 'scanCode'].includes(value),
	},
	devicePosition: {
		type: String,
		default: 'back',
		validator: value => ['front', 'back'].includes(value),
	},
	filter: { type: Number, default: 0 },
	flash: {
		type: String,
		default: 'auto',
		validator: value => ['auto', 'on', 'off', 'torch'].includes(value),
	},
	scanArea: { type: Array, default: () => [] },
	needOutput: { type: Boolean, default: false },
	frameSize: {
		type: String,
		default: '',
		validator: value => ['', 'small', 'medium', 'large'].includes(value),
	},
	centerCrop: { type: Boolean, default: true },
	resolution: {
		type: String,
		default: 'medium',
		validator: value => ['low', 'medium', 'high'].includes(value),
	},
})

const rootRef = ref()
const videoRef = ref()
const info = useInfo()
const type = 'native/camera'
const isNativeCamera = computed(() => isAndroid || isIOS || isHarmonyOS)
const nativeEventOffs = []
let mediaStream
let resizeObserver
let scanFrameId = 0
let syncFrameId = 0
let lastRectKey = ''
let nativeMounted = false
let desktopCameraVersion = 0
let barcodeDetector

function getRect() {
	if (!rootRef.value) return {}
	const rect = rootRef.value.getBoundingClientRect()
	return {
		left: rect.left,
		top: rect.top,
		width: rect.width,
		height: rect.height,
		pageLeft: rect.left + window.scrollX,
		pageTop: rect.top + window.scrollY,
		scrollX: window.scrollX,
		scrollY: window.scrollY,
		viewportWidth: window.innerWidth,
		viewportHeight: window.innerHeight,
	}
}

function getNativeParams() {
	return {
		type,
		id: props.id,
		mode: props.mode,
		devicePosition: props.mode === 'scanCode' ? 'back' : props.devicePosition,
		filter: props.filter,
		flash: props.flash,
		scanArea: props.scanArea,
		needOutput: props.needOutput,
		frameSize: props.frameSize,
		centerCrop: props.centerCrop,
		resolution: props.resolution,
		hidden: rootRef.value?.hasAttribute('hidden') || false,
		rect: getRect(),
	}
}

function invokeNative(apiName) {
	if (!isNativeCamera.value) return
	if (apiName === 'propsUpdate' && !nativeMounted) return
	invokeAPI(apiName, { bridgeId: info.bridgeId, params: getNativeParams() })
}

function bindNativeEvent(eventType) {
	const off = onEvent(`bind${eventType}`, (msg) => {
		if (msg.id !== undefined && msg.id !== props.id && msg.cameraId !== props.id) return
		triggerEvent(eventType, { type: eventType, info, detail: msg })
	})
	nativeEventOffs.push(off)
}

function syncRect(force = false) {
	const rectKey = JSON.stringify({
		...getRect(),
		hidden: rootRef.value?.hasAttribute('hidden') || false,
	})
	if (force || rectKey !== lastRectKey) {
		lastRectKey = rectKey
		invokeNative('propsUpdate')
	}
}

function scheduleSyncRect() {
	if (syncFrameId) return
	syncFrameId = requestAnimationFrame(() => {
		syncFrameId = 0
		syncRect()
	})
}

function triggerCameraEvent(eventType, detail = {}) {
	triggerEvent(eventType, { type: eventType, info, detail })
}

function stopDesktopCamera() {
	desktopCameraVersion++
	if (scanFrameId) cancelAnimationFrame(scanFrameId)
	scanFrameId = 0
	mediaStream?.getTracks().forEach(track => track.stop())
	mediaStream = undefined
	barcodeDetector = undefined
	if (videoRef.value) videoRef.value.srcObject = null
}

async function scanDesktopFrame() {
	if (!mediaStream || props.mode !== 'scanCode' || !barcodeDetector) return
	try {
		const codes = await barcodeDetector.detect(videoRef.value)
		if (codes[0]) {
			triggerCameraEvent('scancode', {
				type: codes[0].format,
				result: codes[0].rawValue,
			})
		}
	}
	catch {
		// The next frame may become readable while the camera is warming up.
	}
	scanFrameId = requestAnimationFrame(scanDesktopFrame)
}

async function startDesktopCamera() {
	stopDesktopCamera()
	const version = desktopCameraVersion
	if (!navigator.mediaDevices?.getUserMedia || !videoRef.value) {
		triggerCameraEvent('error', { errMsg: 'camera:fail camera is not available' })
		return
	}

	try {
		const stream = await navigator.mediaDevices.getUserMedia({
			audio: false,
			video: {
				facingMode: props.mode === 'scanCode' || props.devicePosition === 'back' ? 'environment' : 'user',
			},
		})
		if (version !== desktopCameraVersion || !videoRef.value) {
			stream.getTracks().forEach(track => track.stop())
			return
		}
		mediaStream = stream
		videoRef.value.srcObject = mediaStream
		mediaStream.getVideoTracks()[0]?.addEventListener('ended', () => {
			triggerCameraEvent('stop', { reason: 'camera track ended' })
		})
		await videoRef.value.play()
		const zoom = mediaStream.getVideoTracks()[0]?.getCapabilities?.().zoom
		triggerCameraEvent('initdone', { maxZoom: zoom?.max || 1 })
		if (props.mode === 'scanCode' && window.BarcodeDetector) {
			barcodeDetector = new window.BarcodeDetector()
			scanDesktopFrame()
		}
	}
	catch (error) {
		triggerCameraEvent('error', {
			errMsg: error?.message || 'camera:fail open camera failed',
		})
	}
}

onMounted(() => {
	if (isDesktop) {
		startDesktopCamera()
		return
	}
	if (!isNativeCamera.value) return
	if (isAndroid) ensureNativeLayerTouchBridge()
	for (const eventType of ['stop', 'error', 'output', 'scancode', 'initdone']) bindNativeEvent(eventType)
	nextTick(() => {
		nativeMounted = true
		invokeNative('componentMount')
		lastRectKey = JSON.stringify({ ...getRect(), hidden: rootRef.value?.hasAttribute('hidden') || false })
		window.addEventListener('resize', scheduleSyncRect)
		window.addEventListener('scroll', scheduleSyncRect, true)
		if (window.ResizeObserver && rootRef.value) {
			resizeObserver = new ResizeObserver(scheduleSyncRect)
			resizeObserver.observe(rootRef.value)
		}
	})
})

watch(
	() => getNativeParams(),
	() => invokeNative('propsUpdate'),
	{ deep: true },
)

watch(
	() => [props.mode, props.devicePosition],
	() => {
		if (isDesktop) startDesktopCamera()
	},
)

onBeforeUnmount(() => {
	stopDesktopCamera()
	if (syncFrameId) cancelAnimationFrame(syncFrameId)
	resizeObserver?.disconnect()
	window.removeEventListener('resize', scheduleSyncRect)
	window.removeEventListener('scroll', scheduleSyncRect, true)
	invokeNative('componentUnmount')
	nativeMounted = false
	nativeEventOffs.splice(0).forEach(off => off())
})
</script>

<template>
	<div :id="id" ref="rootRef" v-bind="$attrs" class="dd-camera">
		<video
			v-if="isDesktop"
			ref="videoRef"
			class="dd-camera-native"
			autoplay
			muted
			playsinline
			:style="{ objectFit: centerCrop ? 'cover' : 'contain' }"
		/>
		<div v-else-if="isIOS" class="dd-camera-native dd-camera-container"><div /></div>
		<embed
			v-else-if="isAndroid"
			class="dd-camera-native"
			type="application/view"
			:comp_type="type"
			data-dimina-native-type="native/camera"
			:data-dimina-native-id="id"
		/>
		<embed v-else-if="isHarmonyOS" class="dd-camera-native" :type="type" />
		<div v-else class="dd-camera-unavailable">未找到摄像头</div>
		<div class="dd-camera-slot"><slot /></div>
	</div>
</template>

<style lang="scss">
.dd-camera {
	display: block;
	position: relative;
	overflow: hidden;
	width: 100%;
	&[hidden] { display: none; }
}

.dd-camera-native,
.dd-camera-unavailable,
.dd-camera-slot {
	position: absolute;
	inset: 0;
	width: 100%;
	height: 100%;
}

.dd-camera-container {
	overflow: scroll;
	-webkit-overflow-scrolling: touch;

	> div { width: 101%; height: 101%; }
}

.dd-camera-unavailable {
	color: white;
	background-color: gray;
	display: flex;
	align-items: center;
	justify-content: center;
}

.dd-camera-slot { pointer-events: none; }
.dd-camera-slot * { pointer-events: auto; }
.dd-camera-native[data-dimina-native-type='native/camera'] { background: transparent !important; opacity: 0; }
</style>
