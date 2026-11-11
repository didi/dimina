<script setup>
// 承载网页的容器
// https://developers.weixin.qq.com/miniprogram/dev/component/web-view.html
import { isAndroid, isDesktop, isHarmonyOS } from '@dimina/common'
import { invokeAPI, onEvent, triggerEvent, useInfo } from '@/common/events'
import { ensureNativeLayerTouchBridge } from '@/common/nativeLayerTouchBridge'

const props = defineProps({
	id: { type: String, default: () => `webview-${useId()}` },
	src: { type: String, default: '' },
	embedded: { type: Boolean, default: false },
})

const ENCODE_CHARS_REGEXP = /(?:[^\x21\x25\x26-\x3B\x3D\x3F-\x5B\x5D\x5F\x7E]|%(?:[^0-9A-F]|[0-9A-F][^0-9A-F]|$))+/gi
const UNMATCHED_SURROGATE_PAIR_REGEXP = /(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]|[\uD800-\uDBFF]([^\uDC00-\uDFFF]|$)/g
const UNMATCHED_SURROGATE_PAIR_REPLACE = '$1\uFFFD$2'

const rootRef = ref()
const url = computed(() => props.src
	.replace(UNMATCHED_SURROGATE_PAIR_REGEXP, UNMATCHED_SURROGATE_PAIR_REPLACE)
	.replace(ENCODE_CHARS_REGEXP, encodeURI))
const useFrame = computed(() => props.embedded || isDesktop)
const frameLoadError = computed(() => {
	if (!props.embedded || !url.value) return ''
	const bridge = window.DiminaRenderBridge
	if (isAndroid && !isHarmonyOS && bridge && bridge.mapRenderer !== 'web'
		&& (typeof bridge.supportsEmbeddedWebView !== 'function' || !bridge.supportsEmbeddedWebView())) {
		return 'web-view:fail embedded mode requires an isolated host bridge'
	}
	try {
		if (['http:', 'https:'].includes(new URL(url.value, window.location.href).protocol)) return ''
	} catch { /* Report malformed URLs through the component error event. */ }
	return 'web-view:fail unsupported embedded URL'
})
const validFrameURL = computed(() => !frameLoadError.value)
const frameURL = computed(() => validFrameURL.value ? url.value : 'about:blank')
const type = 'native/webview'
const info = useInfo()
const nativeEventOffs = []
let syncFrameId = 0
let lastRectKey = ''
let resizeObserver
let nativeMounted = false
let mounted = false
let nativeParams

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
	if (apiName === 'componentUnmount') {
		if (nativeMounted) invokeAPI(apiName, { bridgeId: info.bridgeId, params: nativeParams })
		return
	}
	if (useFrame.value || (apiName === 'propsUpdate' && !nativeMounted)) return
	nativeParams = getNativeParams()
	invokeAPI(apiName, { bridgeId: info.bridgeId, params: nativeParams })
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

const FRAME_CHANNEL = 'dimina:web-view:v1'
const navigationMethods = new Set(['H5navigateTo', 'H5navigateBack', 'H5redirectTo', 'H5switchTab', 'H5reLaunch'])

function handleFrameRequest(event) {
	const { kind, session, request } = event.data
	if (typeof session !== 'string') return
	const reply = data => event.source.postMessage({ channel: FRAME_CHANNEL, session, ...data }, event.origin === 'null' ? '*' : event.origin)
	if (kind === 'hello') {
		reply({ kind: 'ready' })
		return
	}
	if (kind !== 'invoke' || !request || typeof request !== 'object') return
	const { type: requestType, body } = request
	if (!body || typeof body !== 'object' || typeof body.name !== 'string') return
	const params = body.params?.data?.params || {}
	const callback = (args) => {
		if (typeof body.params?.success === 'string') reply({ kind: 'callback', id: body.params.success, args })
	}
	if (requestType === 'h5SdkAction' && body.name === 'h5postMessage') {
		emitFrameMessage(event, [params.data])
	}
	else if (requestType === 'invokeAPI' && body.name === 'getEnv') {
		callback({ data: { miniprogram: true } })
	}
	else if (requestType === 'h5SdkAction' && navigationMethods.has(body.name)) {
		// Keep relative URL resolution in the service route API. Guest-supplied
		// bridge IDs, handler names and callback IDs never cross this boundary.
		window.__message.send({
			type: 'h5SdkAction', target: 'service',
			body: {
				name: body.name, bridgeId: info.bridgeId,
				params: { url: params.url, delta: params.delta },
			},
		})
		callback({ data: {} })
	}
	else {
		callback({ data: { success: false, errMsg: `${body.name}:fail unsupported in embedded web-view` } })
	}
}

function emitFrameMessage(event, data) {
	triggerEvent('message', {
		type: 'message',
		info,
		currentTarget: rootRef.value,
		event: {
			target: rootRef.value,
			currentTarget: rootRef.value,
			stopPropagation: () => event.stopPropagation(),
		},
		detail: { data },
	})
}

function handleFrameMessage(event) {
	if (!useFrame.value || !validFrameURL.value || event.source !== rootRef.value?.contentWindow) return
	if (event.data?.channel === FRAME_CHANNEL) handleFrameRequest(event)
	else emitFrameMessage(event, props.embedded ? [event.data] : event.data)
}

function handleFrameLoad(event) {
	if (!useFrame.value || !validFrameURL.value || event.currentTarget !== rootRef.value) return
	triggerEvent('load', {
		type: 'load',
		event,
		info,
		detail: { src: url.value },
	})
}

function handleFrameError(event) {
	if (event && (!useFrame.value || event.currentTarget !== rootRef.value)) return
	triggerEvent('error', {
		type: 'error',
		event,
		info,
		detail: { url: url.value, fullUrl: url.value, errMsg: frameLoadError.value || 'web-view:fail load error' },
	})
}

function startNative() {
	if (useFrame.value) return
	if (nativeMounted) {
		invokeNative('propsUpdate')
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
}

function stopNative() {
	if (!nativeMounted) return
	if (syncFrameId) cancelAnimationFrame(syncFrameId)
	syncFrameId = 0
	resizeObserver?.disconnect()
	resizeObserver = undefined
	window.removeEventListener('resize', scheduleSyncRect)
	window.removeEventListener('scroll', scheduleSyncRect, true)
	invokeNative('componentUnmount')
	nativeMounted = false
	nativeEventOffs.splice(0).forEach(off => off())
}

function syncMode() {
	if (!mounted) return
	if (!useFrame.value) startNative()
	else if (!validFrameURL.value) handleFrameError()
}

onMounted(() => {
	mounted = true
	window.addEventListener('message', handleFrameMessage)
	syncMode()
})

watch(() => [useFrame.value, props.id], stopNative)
watch(
	() => [useFrame.value, props.id, url.value],
	syncMode,
	{ flush: 'post' },
)

onBeforeUnmount(() => {
	mounted = false
	window.removeEventListener('message', handleFrameMessage)
	stopNative()
})
</script>

<template>
	<iframe
		v-if="useFrame"
		:key="`${id}:${url}`"
		:id="id"
		ref="rootRef"
		v-bind="$attrs"
		class="dd-web-view"
		:class="embedded ? 'dd-web-view-embedded' : 'dd-web-view-pc'"
		:src="frameURL"
		@load="handleFrameLoad"
		@error="handleFrameError"
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

.dd-web-view-embedded {
	width: 100%;
	height: 150px;
	border: 0;
}
</style>
