<script setup>
// 地图
// https://developers.weixin.qq.com/miniprogram/dev/component/map.html
import { isAndroid, isDesktop, isHarmonyOS, isIOS } from '@dimina/common'
import { invokeAPI, onEvent, triggerEvent, useInfo } from '@/common/events'
import { ensureNativeLayerTouchBridge } from '@/common/nativeLayerTouchBridge'

const props = defineProps({
	id: { type: String, default: () => `map-${useId()}` },
	latitude: { type: Number, default: 39.92 },
	longitude: { type: Number, default: 116.46 },
	scale: { type: Number, default: 16 },
	markers: { type: Array, default: () => [] },
	covers: { type: Array, default: () => [] },
	includePoints: { type: Array, default: () => [] },
	polyline: { type: Array, default: () => [] },
	circles: { type: Array, default: () => [] },
	controls: { type: Array, default: () => [] },
	polygons: { type: Array, default: () => [] },
	showLocation: { type: Boolean, default: false },
	showScale: { type: Boolean, default: false },
	showCompass: { type: Boolean, default: false },
	theme: { type: String, default: 'normal' },
	subkey: { type: String, default: '' },
	layerStyle: { type: Number, default: 1 },
	usePluginId: { type: Boolean, default: false },
	enableZoom: { type: Boolean, default: true },
	enableScroll: { type: Boolean, default: true },
	enableRotate: { type: Boolean, default: false },
	enable3D: { type: Boolean, default: false },
	enableOverlooking: { type: Boolean, default: false },
	enableAutoMaxOverlooking: { type: Boolean, default: false },
	enableSatellite: { type: Boolean, default: false },
	enableTraffic: { type: Boolean, default: false },
	enablePoi: { type: Boolean, default: true },
	// 兼容 Dimina 旧属性拼写；未显式传入时以 exparser 的 enable-poi 为准。
	enablePOI: { type: Boolean, default: undefined },
	enableBuilding: { type: Boolean, default: true },
	enableIndoor: { type: Boolean, default: false },
	enableIndoorBuildingPick: { type: Boolean, default: false },
	enableIndoorLevelPick: { type: Boolean, default: false },
	rotate: { type: Number, default: 0 },
	skew: { type: Number, default: 0 },
	minScale: { type: Number, default: 3 },
	maxScale: { type: Number, default: 22 },
	setting: { type: Object, default: () => ({}) },
})

const rootRef = ref()
const info = useInfo()
const type = 'native/map'
const isNativeMap = computed(() => isAndroid || isIOS || isHarmonyOS)
const nativeEventOffs = []
let resizeObserver
let syncFrameId = 0
let lastRectKey = ''
let nativeMounted = false

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
	const enablePoi = props.enablePOI === undefined ? props.enablePoi : props.enablePOI
	return {
		latitude: props.latitude,
		longitude: props.longitude,
		scale: props.scale,
		markers: props.markers,
		covers: props.covers,
		includePoints: props.includePoints,
		polyline: props.polyline,
		circles: props.circles,
		controls: props.controls,
		polygons: props.polygons,
		showLocation: props.showLocation,
		showScale: props.showScale,
		showCompass: props.showCompass,
		theme: props.theme,
		subkey: props.subkey,
		layerStyle: props.layerStyle,
		usePluginId: props.usePluginId,
		enableZoom: props.enableZoom,
		enableScroll: props.enableScroll,
		enableRotate: props.enableRotate,
		enable3D: props.enable3D,
		enableOverlooking: props.enableOverlooking,
		enableAutoMaxOverlooking: props.enableAutoMaxOverlooking,
		enableSatellite: props.enableSatellite,
		enableTraffic: props.enableTraffic,
		enablePoi,
		enablePOI: enablePoi,
		enableBuilding: props.enableBuilding,
		enableIndoor: props.enableIndoor,
		enableIndoorBuildingPick: props.enableIndoorBuildingPick,
		enableIndoorLevelPick: props.enableIndoorLevelPick,
		rotate: props.rotate,
		skew: props.skew,
		minScale: props.minScale,
		maxScale: props.maxScale,
		setting: props.setting,
		...props.setting,
		type,
		id: props.id,
		hidden: rootRef.value?.hasAttribute('hidden') || false,
		rect: getRect(),
	}
}

function invokeNative(apiName) {
	if (!isNativeMap.value) return
	if (apiName === 'propsUpdate' && !nativeMounted) return
	invokeAPI(apiName, {
		bridgeId: info.bridgeId,
		params: getNativeParams(),
	})
}

function bindNativeEvent(nativeEvent, eventType) {
	const off = onEvent(nativeEvent, (msg) => {
		if (msg.id !== undefined && msg.id !== props.id && msg.mapId !== props.id) return
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

onMounted(() => {
	if (!isNativeMap.value) return
	if (isAndroid) ensureNativeLayerTouchBridge()

	for (const eventType of [
		'callouttap',
		'markertap',
		'labeltap',
		'controltap',
		'regionchange',
		'tap',
		'indoorchange',
		'poitap',
		'anchorpointtap',
		'updated',
		'rendersuccess',
		'error',
	]) bindNativeEvent(`bind${eventType}`, eventType)

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

onBeforeUnmount(() => {
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
	<div :id="id" ref="rootRef" v-bind="$attrs" class="dd-map">
		<div v-if="isDesktop" class="dd-map-desktop">未实现组件</div>
		<div v-else-if="isIOS" class="dd-map-native dd-map-container"><div /></div>
		<embed
			v-else-if="isAndroid"
			class="dd-map-native"
			type="application/view"
			:comp_type="type"
			data-dimina-native-type="native/map"
			:data-dimina-native-id="id"
		/>
		<embed v-else-if="isHarmonyOS" class="dd-map-native" :type="type" />
		<div v-else class="dd-map-desktop">未实现组件</div>
		<div class="dd-map-slot"><slot /></div>
	</div>
</template>

<style lang="scss">
.dd-map {
	display: block;
	position: relative;
	overflow: hidden;
	width: 300px;
	height: 150px;

	&[hidden] { display: none; }
}

.dd-map-native,
.dd-map-desktop,
.dd-map-slot {
	position: absolute;
	inset: 0;
	width: 100%;
	height: 100%;
}

.dd-map-container {
	overflow: scroll;
	-webkit-overflow-scrolling: touch;

	> div { width: 101%; height: 101%; }
}

.dd-map-desktop {
	color: white;
	background-color: gray;
	display: flex;
	align-items: center;
	justify-content: center;
}

.dd-map-slot { pointer-events: none; }
.dd-map-slot * { pointer-events: auto; }
.dd-map-native[data-dimina-native-type='native/map'] { background: transparent !important; opacity: 0; }
</style>
