import { reportAppError } from './app-events'

const listeners = {
	touchstart: [],
	touchmove: [],
	touchend: [],
	touchcancel: [],
}

export function onGameTouch(type, listener) {
	if (!listeners[type] || typeof listener !== 'function') {
		return
	}
	listeners[type].push(listener)
}

export function offGameTouch(type, listener) {
	if (!listeners[type]) {
		return
	}
	if (!listener) {
		listeners[type] = []
		return
	}
	listeners[type] = listeners[type].filter(item => item !== listener)
}

export function emitGameTouch(type, event = {}) {
	if (!listeners[type]) {
		return
	}
	for (const listener of [...listeners[type]]) {
		try {
			listener(event)
		}
		catch (error) {
			reportAppError(error)
		}
	}
}

export function resetGameTouchEvents() {
	for (const type of Object.keys(listeners)) {
		listeners[type] = []
	}
}
