import { isAndroid } from '@dimina/common'

const NATIVE_PLACEHOLDER_SELECTOR = '[data-dimina-native-id][data-dimina-native-type]'
const activePointers = new Map()
const pointerIdMap = new Map()
const freePointerIds = []

let installed = false
let activeTarget = null
let nextPointerId = 0

function getBridge() {
	return window.DiminaNativeComponentBridge
}

function findNativeTarget(touch) {
	const element = document.elementFromPoint(touch.clientX, touch.clientY)
	const nativeElement = element?.closest?.(NATIVE_PLACEHOLDER_SELECTOR)
	if (!nativeElement) {
		return null
	}
	const id = nativeElement.dataset.diminaNativeId
	const type = nativeElement.dataset.diminaNativeType
	if (!id || !type) {
		return null
	}
	return { id, type }
}

function acquirePointerId(touchIdentifier) {
	if (pointerIdMap.has(touchIdentifier)) {
		return pointerIdMap.get(touchIdentifier)
	}
	const pointerId = freePointerIds.length ? freePointerIds.shift() : nextPointerId++
	pointerIdMap.set(touchIdentifier, pointerId)
	return pointerId
}

function releasePointerId(touchIdentifier) {
	if (!pointerIdMap.has(touchIdentifier)) {
		return
	}
	freePointerIds.push(pointerIdMap.get(touchIdentifier))
	pointerIdMap.delete(touchIdentifier)
}

function normalizeTouch(touch) {
	const touchIdentifier = String(touch.identifier)
	return {
		touchIdentifier,
		id: acquirePointerId(touchIdentifier),
		clientX: touch.clientX,
		clientY: touch.clientY,
		pageX: touch.pageX,
		pageY: touch.pageY,
	}
}

function updateActivePointers(touches) {
	for (const touch of touches) {
		const touchIdentifier = String(touch.identifier)
		if (activePointers.has(touchIdentifier)) {
			activePointers.set(touchIdentifier, normalizeTouch(touch))
		}
	}
}

function sendTouch(action, actionPointerId) {
	const bridge = getBridge()
	if (!bridge?.dispatchTouch || !activeTarget || !activePointers.size) {
		return
	}
	bridge.dispatchTouch(JSON.stringify({
		action,
		actionPointerId,
		targetId: activeTarget.id,
		targetType: activeTarget.type,
		viewportWidth: window.innerWidth,
		viewportHeight: window.innerHeight,
		pointers: Array.from(activePointers.values()).map((pointer) => ({
			id: pointer.id,
			clientX: pointer.clientX,
			clientY: pointer.clientY,
			pageX: pointer.pageX,
			pageY: pointer.pageY,
		})),
	}))
}

function consume(event) {
	event.preventDefault()
	event.stopImmediatePropagation()
}

function onTouchStart(event) {
	if (!getBridge()?.dispatchTouch) {
		return
	}

	let consumed = false
	for (const touch of event.changedTouches) {
		const target = activeTarget || findNativeTarget(touch)
		if (!target || (activeTarget && target.id !== activeTarget.id)) {
			continue
		}

		activeTarget = target
		updateActivePointers(event.touches)
		const pointer = normalizeTouch(touch)
		activePointers.set(pointer.touchIdentifier, pointer)
		sendTouch(activePointers.size === 1 ? 'down' : 'pointerDown', pointer.id)
		consumed = true
	}

	if (consumed) {
		consume(event)
	}
}

function onTouchMove(event) {
	if (!activeTarget || !activePointers.size) {
		return
	}
	updateActivePointers(event.touches)
	sendTouch('move', -1)
	consume(event)
}

function onTouchEnd(event) {
	if (!activeTarget || !activePointers.size) {
		return
	}

	let consumed = false
	updateActivePointers(event.touches)
	for (const touch of event.changedTouches) {
		const touchIdentifier = String(touch.identifier)
		if (!activePointers.has(touchIdentifier)) {
			continue
		}
		const pointer = normalizeTouch(touch)
		activePointers.set(touchIdentifier, pointer)
		sendTouch(activePointers.size === 1 ? 'up' : 'pointerUp', pointer.id)
		activePointers.delete(touchIdentifier)
		releasePointerId(touchIdentifier)
		consumed = true
	}

	if (!activePointers.size) {
		activeTarget = null
	}
	if (consumed) {
		consume(event)
	}
}

function onTouchCancel(event) {
	if (!activeTarget || !activePointers.size) {
		return
	}
	updateActivePointers(event.touches)
	sendTouch('cancel', -1)
	for (const touchIdentifier of activePointers.keys()) {
		releasePointerId(touchIdentifier)
	}
	activePointers.clear()
	activeTarget = null
	consume(event)
}

export function ensureNativeLayerTouchBridge() {
	if (!isAndroid || installed || typeof document === 'undefined') {
		return
	}
	installed = true
	document.addEventListener('touchstart', onTouchStart, { capture: true, passive: false })
	document.addEventListener('touchmove', onTouchMove, { capture: true, passive: false })
	document.addEventListener('touchend', onTouchEnd, { capture: true, passive: false })
	document.addEventListener('touchcancel', onTouchCancel, { capture: true, passive: false })
}
