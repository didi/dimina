<script setup>
// Canvas 组件
// https://developers.weixin.qq.com/miniprogram/dev/component/canvas.html
import { isHarmonyOS, isDesktop, isAndroid, isIOS, isEmbedEnabled } from '@dimina/common'
import { hasEvent, invokeAPI, triggerEvent, useInfo } from '@/common/events'
import { useTouchEvents } from '@/common/useTouchEvents'

const props = defineProps({
	canvasId: {
		type: String,
		default: '',
	},
	disableScroll: {
		type: Boolean,
		default: false,
	},
	type: {
		type: String,
		default: '',
	},
	newTouchListener: {
		type: Boolean,
		default: false,
	},
	renderWidth: {
		type: Number,
		default: 300,
	},
	renderHeight: {
		type: Number,
		default: 150,
	},
})

const info = useInfo()
const canvasRef = ref(null)
const rootRef = ref(null)
const isError = ref(false)

const hasTouchEvents = ['touchstart', 'touchmove', 'touchend', 'touchcancel', 'longpress', 'longtap']
	.some(eventName => hasEvent(info, eventName))
if (hasTouchEvents) {
	useTouchEvents(info, rootRef)
}

function preventScroll(event) {
	if (props.disableScroll && event.cancelable) {
		event.preventDefault()
	}
}

const isNativeCanvas = computed(() => isEmbedEnabled && (isAndroid || isIOS || isHarmonyOS))
const canvasNodeId = computed(() => props.canvasId || `canvas-${Math.random().toString(36).slice(2, 10)}`)
const nativeType = 'native/canvas'

let syncFrameId = 0
let lastRectKey = ''
let resizeObserver

function getRect() {
	const element = rootRef.value
	if (!element) {
		return {}
	}
	const rect = element.getBoundingClientRect()
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
		type: nativeType,
		id: canvasNodeId.value,
		hidden: rootRef.value?.hasAttribute('hidden') || false,
		rect: getRect(),
	}
}

function invokeNative(apiName) {
	if (!isNativeCanvas.value) {
		return
	}
	invokeAPI(apiName, {
		bridgeId: info.bridgeId,
		params: getNativeParams(),
	})
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
	if (syncFrameId) {
		return
	}
	syncFrameId = requestAnimationFrame(() => {
		syncFrameId = 0
		syncRect()
	})
}

onMounted(() => {
	// Non-native canvas: validate canvasId
	if (!isNativeCanvas.value) {
		if (props.type) return
		let errMsg
		if (!props.canvasId) {
			errMsg = 'canvas-id attribute is undefined'
		}
		else {
			const scope = rootRef.value.closest('.dd-page') || document
			const duplicates = Array.from(scope.querySelectorAll('canvas[canvas-id]'))
				.filter(canvas => canvas.getAttribute('canvas-id') === props.canvasId)
			if (duplicates.length > 1) errMsg = `canvas-id ${props.canvasId} in this page has already existed`
		}
		if (errMsg) {
			isError.value = true
			triggerEvent('error', { info, detail: { errMsg } })
		}
		return
	}

	// Native canvas: mount and sync rect
	const el = rootRef.value
	console.log('[render] [Canvas] onMounted id=' + canvasNodeId.value + ' isNative=' + isNativeCanvas.value + ' tag=' + el?.tagName + ' el=' + !!el)

	nextTick(() => {
		syncRect(true)
		invokeNative('componentMount')
		window.addEventListener('resize', scheduleSyncRect)
		if (window.ResizeObserver && rootRef.value) {
			resizeObserver = new ResizeObserver(scheduleSyncRect)
			resizeObserver.observe(rootRef.value)
		}

		// Register global handler for native canvas touch event forwarding (HarmonyOS)
		if (isHarmonyOS && typeof window.__diminaDispatchNativeTouch === 'undefined') {
			window.__diminaDispatchNativeTouch = function (data) {
				const el = document.getElementById(data.id)
				if (!el) return
				const rect = el.getBoundingClientRect()
				const makeTouch = (t) => new Touch({
					identifier: t.id,
					target: el,
					clientX: rect.left + t.x,
					clientY: rect.top + t.y,
					pageX: rect.left + t.x + window.scrollX,
					pageY: rect.top + t.y + window.scrollY,
				})
				const touches = data.touches.map(makeTouch)
				const changed = data.changed.map(makeTouch)
				const event = new TouchEvent(data.type, {
					bubbles: true,
					cancelable: true,
					touches: touches,
					changedTouches: changed,
					targetTouches: touches,
				})
				el.dispatchEvent(event)
			}
		}
	})
})

onBeforeUnmount(() => {
	if (!isNativeCanvas.value) {
		return
	}
	if (syncFrameId) {
		cancelAnimationFrame(syncFrameId)
	}
	resizeObserver?.disconnect()
	window.removeEventListener('resize', scheduleSyncRect)
	invokeNative('componentUnmount')
})
</script>

<template>
	<!-- Native canvas paths -->
	<embed
		v-if="isAndroid && isEmbedEnabled"
		:id="canvasNodeId"
		ref="rootRef"
		v-bind="$attrs"
		class="dd-canvas"
		data-dimina-native-type="native/canvas"
		:data-dimina-native-id="canvasNodeId"
		type="application/view"
		comp_type="native/canvas"
	/>
	<div
		v-else-if="isIOS && isEmbedEnabled"
		:id="canvasNodeId"
		ref="rootRef"
		v-bind="$attrs"
		class="dd-canvas"
		data-native-canvas
	/>
	<embed
		v-else-if="isHarmonyOS && isEmbedEnabled"
		:id="canvasNodeId"
		ref="rootRef"
		v-bind="$attrs"
		class="dd-canvas"
		:type="nativeType"
		@touchmove="preventScroll"
	/>
	<!-- Web fallback canvas -->
	<div v-else ref="rootRef" v-bind="$attrs" class="dd-canvas" :style="isError ? { display: 'none' } : undefined" @touchmove="preventScroll">
		<canvas
			ref="canvasRef" :canvas-id="canvasId" :data-type="type || undefined"
			:width="renderWidth" :height="renderHeight"
		/>
		<div class="dd-canvas-slot">
			<slot />
		</div>
	</div>
</template>

<style lang="scss">
.dd-canvas {
	display: block;
	position: relative;
	width: 300px;
	height: 150px;

	> canvas {
		position: absolute;
		top: 0;
		left: 0;
		width: 100%;
		height: 100%;
	}

	&[hidden] {
		display: none;
	}
}

.dd-canvas-slot {
	position: absolute;
	top: 0;
	left: 0;
	width: 100%;
	height: 100%;
	overflow: hidden;
	pointer-events: none;

	* {
		pointer-events: auto;
	}
}
</style>
