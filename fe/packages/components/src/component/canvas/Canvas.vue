<script setup>
// Canvas 组件
// https://developers.weixin.qq.com/miniprogram/dev/component/canvas.html
import { isHarmonyOS, isDesktop, isAndroid, isIOS } from '@dimina/common'
import { invokeAPI, useInfo } from '@/common/events'

const props = defineProps({
	id: {
		type: String,
		default: () => `canvas-${Math.random().toString(36).slice(2, 10)}`,
	},
	canvasId: {
		type: String,
		default: '',
	},
	type: {
		type: String,
		default: '2d',
	},
	disableScroll: {
		type: Boolean,
		default: false,
	},
})

const rootRef = ref()
const info = useInfo()
const isNativeCanvas = computed(() => isAndroid || isIOS || isHarmonyOS)
let syncFrameId = 0
let lastRectKey = ''
let resizeObserver

const canvasNodeId = computed(() => props.canvasId || props.id)
const nativeType = 'native/canvas'

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
	if (!isNativeCanvas.value) {
		return
	}

	nextTick(() => {
		syncRect(true)
		invokeNative('componentMount')
		window.addEventListener('resize', scheduleSyncRect)
		if (window.ResizeObserver && rootRef.value) {
			resizeObserver = new ResizeObserver(scheduleSyncRect)
			resizeObserver.observe(rootRef.value)
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
	<embed
		v-if="isAndroid"
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
		v-else-if="isIOS"
		:id="canvasNodeId"
		ref="rootRef"
		v-bind="$attrs"
		class="dd-canvas"
		data-native-canvas
	/>
	<embed
		v-else-if="isHarmonyOS"
		:id="canvasNodeId"
		ref="rootRef"
		v-bind="$attrs"
		class="dd-canvas"
		:type="nativeType"
	/>
	<canvas
		v-else
		:id="canvasNodeId"
		ref="rootRef"
		v-bind="$attrs"
		class="dd-canvas"
		:data-canvas-id="canvasNodeId"
		:data-type="props.type"
	/>
</template>

<style lang="scss">
.dd-canvas {
	display: inline-block;
	position: relative;
	width: 300px;
	height: 150px;
	overflow: hidden;

	&[hidden] {
		display: none;
	}
}
</style>
