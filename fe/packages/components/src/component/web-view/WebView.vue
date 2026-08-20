<script setup>
// 承载网页的容器
// https://developers.weixin.qq.com/miniprogram/dev/component/web-view.html
import { isAndroid, isDesktop } from '@dimina/common'
import { invokeAPI, onEvent, triggerEvent, useInfo } from '@/common/events'
import { ensureNativeLayerTouchBridge } from '@/common/nativeLayerTouchBridge'

const props = defineProps({
	id: { type: String, default: () => `webview-${useId()}` },
	src: { type: String, default: '' },
})

const ENCODE_CHARS_REGEXP = /(?:[^\x21\x25\x26-\x3B\x3D\x3F-\x5B\x5D\x5F\x7E]|%(?:[^0-9A-F]|[0-9A-F][^0-9A-F]|$))+/gi
const UNMATCHED_SURROGATE_PAIR_REGEXP = /(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]|[\uD800-\uDBFF]([^\uDC00-\uDFFF]|$)/g
const UNMATCHED_SURROGATE_PAIR_REPLACE = '$1\uFFFD$2'

const rootRef = ref()
const url = computed(() => props.src
	.replace(UNMATCHED_SURROGATE_PAIR_REGEXP, UNMATCHED_SURROGATE_PAIR_REPLACE)
	.replace(ENCODE_CHARS_REGEXP, encodeURI))
const type = 'native/webview'
const info = useInfo()
const nativeEventOffs = []
let syncFrameId = 0
let lastRectKey = ''
let resizeObserver
let nativeMounted = false

function getRect() {
	const element = rootRef.value
	if (!element) return {}

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

function getEventAttrs() {
	const eventAttrs = {}
	for (const attrName in info.attrs) {
		if (attrName.startsWith('bind') || attrName.startsWith('catch')) {
			eventAttrs[attrName.replace(/^(?:bind:|bind|catch:|catch)/, '')] = info.attrs[attrName]
		}
	}
	return eventAttrs
}

function getNativeParams() {
	return {
		type,
		url: url.value,
		src: url.value,
		id: props.id,
		bridgeId: info.bridgeId,
		hidden: rootRef.value?.hasAttribute('hidden') || false,
		rect: getRect(),
		attributes: {
			moduleId: info.moduleId,
			attrs: getEventAttrs(),
			src: url.value,
			javascript: `
				function handleSdkFn(){
					window.__wxjs_environment = 'miniprogram';
					var sdk = document.createElement('script');
					sdk.onload = function(){ window.dispatchEvent(new Event('didiJsBridgeLoaded')); };
					sdk.src = 'https://dpubstatic.udache.com/static/dpubimg/UBi0mvYdYcbwXv5qZ9ANw_jdimina_next.js?' + Date.now();
					document.getElementsByTagName('html')[0].appendChild(sdk);
				}
				handleSdkFn();`,
		},
	}
}

function invokeNative(apiName) {
	if (isDesktop) return
	if (apiName === 'propsUpdate' && !nativeMounted) return
	invokeAPI(apiName, { bridgeId: info.bridgeId, params: getNativeParams() })
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

function bindNativeEvent(nativeEvent, eventType, detailFactory = msg => msg) {
	const off = onEvent(nativeEvent, (msg) => {
		if (msg.id !== undefined && msg.id !== props.id && msg.webviewId !== props.id) return
		triggerEvent(eventType, {
			type: eventType,
			info,
			detail: detailFactory(msg),
		})
	})
	nativeEventOffs.push(off)
}

function handleDesktopMessage(event) {
	if (event.source !== rootRef.value?.contentWindow) return
	triggerEvent('message', {
		type: 'message',
		info,
		detail: { data: event.data },
	})
}

function handleDesktopLoad(event) {
	triggerEvent('load', {
		type: 'load',
		event,
		info,
		detail: { src: url.value },
	})
}

function handleDesktopError(event) {
	triggerEvent('error', {
		type: 'error',
		event,
		info,
		detail: { url: url.value, fullUrl: url.value },
	})
}

onMounted(() => {
	if (isDesktop) {
		window.addEventListener('message', handleDesktopMessage)
		return
	}

	bindNativeEvent('bindmessage', 'message', msg => ({ data: msg.data }))
	bindNativeEvent('bindload', 'load', msg => ({ src: msg.src || msg.url, id: msg.id }))
	bindNativeEvent('binderror', 'error', msg => ({
		url: msg.url,
		fullUrl: msg.fullUrl,
		id: msg.id,
	}))
	if (isAndroid) ensureNativeLayerTouchBridge()
	nativeMounted = true
	invokeNative('componentMount')
	lastRectKey = JSON.stringify({
		...getRect(),
		hidden: rootRef.value?.hasAttribute('hidden') || false,
	})
	window.addEventListener('resize', scheduleSyncRect)
	window.addEventListener('scroll', scheduleSyncRect, true)
	if (window.ResizeObserver && rootRef.value) {
		resizeObserver = new ResizeObserver(scheduleSyncRect)
		resizeObserver.observe(rootRef.value)
	}
})

watch(
	() => [props.id, url.value],
	() => invokeNative('propsUpdate'),
)

onBeforeUnmount(() => {
	window.removeEventListener('message', handleDesktopMessage)
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
	<iframe
		v-if="isDesktop"
		:id="id"
		ref="rootRef"
		v-bind="$attrs"
		class="dd-web-view dd-web-view-pc"
		:src="url"
		@load="handleDesktopLoad"
		@error="handleDesktopError"
	/>
	<embed
		v-else
		:id="id"
		ref="rootRef"
		v-bind="$attrs"
		class="dd-web-view"
		:type="type"
		:data-dimina-native-id="id"
		:data-dimina-native-type="type"
	/>
</template>

<style lang="scss">
// 宽高属性设置 100% 在鸿蒙收到为 0，因此原生层使用视口单位。
.dd-web-view {
	display: block;
	width: 100vw;
	height: 100vh;

	&[hidden] { display: none; }
}

.dd-web-view-pc {
	position: absolute;
	left: 0;
	top: 0;
	width: 100%;
	height: 100%;
	border: 0;
}
</style>
