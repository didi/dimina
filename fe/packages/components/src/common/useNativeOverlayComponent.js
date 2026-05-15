import { isAndroid } from '@dimina/common'
import { hasEvent, invokeAPI, onEvent, triggerEvent, useInfo } from './events'

function getRect(element) {
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

function getStyle(element) {
	if (!element) {
		return {}
	}
	const style = window.getComputedStyle(element)
	return {
		backgroundColor: style.backgroundColor,
		borderRadius: style.borderRadius,
		color: style.color,
		fontSize: style.fontSize,
		fontWeight: style.fontWeight,
		lineHeight: style.lineHeight,
		opacity: style.opacity,
		textAlign: style.textAlign,
		zIndex: style.zIndex,
	}
}

function createNativeEvent(element, msg) {
	return {
		currentTarget: element,
		target: element,
		pageX: msg.x,
		pageY: msg.y,
		stopPropagation() {},
		preventDefault() {},
	}
}

export function useNativeOverlayComponent({ type, rootRef, getParams = () => ({}), watchSources }) {
	const info = useInfo()
	const attrs = useAttrs()
	const generatedId = `${type.replace(/[^a-z0-9]/gi, '-')}-${Math.random().toString(36).slice(2, 10)}`
	const nativeId = computed(() => attrs.id || generatedId)
	const nativeEventOffs = []
	let resizeObserver
	let mutationObserver
	let syncFrameId = 0
	let lastKey = ''

	function getNativeParams() {
		const element = rootRef.value
		return {
			type,
			id: nativeId.value,
			hidden: element?.hasAttribute('hidden') || false,
			tappable: hasEvent(info, 'tap'),
			rect: getRect(element),
			style: getStyle(element),
			...getParams(),
		}
	}

	function invokeNative(apiName) {
		if (!isAndroid) {
			return
		}
		invokeAPI(apiName, {
			bridgeId: info.bridgeId,
			params: getNativeParams(),
		})
	}

	function syncNative(force = false) {
		const key = JSON.stringify(getNativeParams())
		if (force || key !== lastKey) {
			lastKey = key
			invokeNative('propsUpdate')
		}
	}

	function scheduleSyncNative() {
		if (syncFrameId) {
			return
		}
		syncFrameId = requestAnimationFrame(() => {
			syncFrameId = 0
			syncNative()
		})
	}

	function bindNativeEvent(nativeEvent, eventType, detailFactory = msg => msg) {
		const off = onEvent(nativeEvent, (msg) => {
			if (msg.id !== nativeId.value) {
				return
			}
			const element = rootRef.value
			triggerEvent(eventType, {
				event: createNativeEvent(element, msg),
				info,
				detail: detailFactory(msg),
			})
		})
		nativeEventOffs.push(off)
	}

	onMounted(() => {
		if (!isAndroid) {
			return
		}

		bindNativeEvent('bindtap', 'tap')
		bindNativeEvent('bindload', 'load')
		bindNativeEvent('binderror', 'error', msg => ({ errMsg: msg.errMsg }))

		nextTick(() => {
			syncNative(true)
			invokeNative('componentMount')
			window.addEventListener('resize', scheduleSyncNative)
			if (window.ResizeObserver && rootRef.value) {
				resizeObserver = new ResizeObserver(scheduleSyncNative)
				resizeObserver.observe(rootRef.value)
			}
			if (window.MutationObserver && rootRef.value) {
				mutationObserver = new MutationObserver(scheduleSyncNative)
				mutationObserver.observe(rootRef.value, {
					attributes: true,
					childList: true,
					characterData: true,
					subtree: true,
				})
			}
		})
	})

	if (watchSources) {
		watch(watchSources, () => syncNative(true))
	}

	onBeforeUnmount(() => {
		if (!isAndroid) {
			return
		}
		if (syncFrameId) {
			cancelAnimationFrame(syncFrameId)
		}
		resizeObserver?.disconnect()
		mutationObserver?.disconnect()
		window.removeEventListener('resize', scheduleSyncNative)
		invokeNative('componentUnmount')
		nativeEventOffs.splice(0).forEach(off => off())
	})

	return {
		isAndroid,
		nativeId,
		scheduleSyncNative,
	}
}
