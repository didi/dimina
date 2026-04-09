import { hasEvent, triggerEvent } from './events'

export function useNativeEvents(info, elementRef, eventTypes) {
	const activeEventTypes = eventTypes.filter(type => hasEvent(info, type))
	if (!activeEventTypes.length) {
		return
	}

	const handlers = new Map()

	onMounted(() => {
		const el = elementRef.value
		if (!el) {
			return
		}

		activeEventTypes.forEach((type) => {
			const handler = event => triggerEvent(type, { event, info })
			handlers.set(type, handler)
			el.addEventListener(type, handler)
		})
	})

	onUnmounted(() => {
		const el = elementRef.value
		if (!el) {
			return
		}

		handlers.forEach((handler, type) => {
			el.removeEventListener(type, handler)
		})
		handlers.clear()
	})
}
