import { hasEvent, triggerEvent } from './events'

/**
 * Web approximation of the mini-program keyboardheightchange event. Native
 * containers can still deliver their own exact keyboard animation duration.
 */
export function useKeyboardHeight(info, active) {
	if (!hasEvent(info, 'keyboardheightchange')) return

	let layoutHeight = 0
	let lastHeight = 0

	function emitHeight(height) {
		const nextHeight = Math.max(Math.round(height), 0)
		if (nextHeight === lastHeight) return
		lastHeight = nextHeight
		triggerEvent('keyboardheightchange', {
			info,
			detail: { height: nextHeight, duration: 0 },
		})
	}

	function handleViewportResize() {
		if (!active.value) return
		const viewport = window.visualViewport
		const visibleBottom = viewport ? viewport.height + viewport.offsetTop : window.innerHeight
		emitHeight(layoutHeight - visibleBottom)
	}

	onMounted(() => {
		layoutHeight = Math.max(window.innerHeight, document.documentElement.clientHeight)
		window.visualViewport?.addEventListener('resize', handleViewportResize)
		window.addEventListener('resize', handleViewportResize)
	})

	watch(active, (focused) => {
		if (focused) handleViewportResize()
		else emitHeight(0)
	})

	onBeforeUnmount(() => {
		window.visualViewport?.removeEventListener('resize', handleViewportResize)
		window.removeEventListener('resize', handleViewportResize)
	})
}
