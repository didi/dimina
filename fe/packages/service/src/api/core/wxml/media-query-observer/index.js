import { callback, isFunction } from '@dimina/common'
import { invokeAPI } from '@/api/common'

function normalizeCondition(condition = {}) {
	const normalized = {}
	for (const key of ['minWidth', 'maxWidth', 'width', 'minHeight', 'maxHeight', 'height']) {
		const value = Number(condition[key])
		if (Number.isFinite(value) && value >= 0) {
			normalized[key] = value
		}
	}

	if (typeof condition.orientation === 'string' && /^[-_a-z0-9]+$/i.test(condition.orientation)) {
		normalized.orientation = condition.orientation
	}
	return normalized
}

export function createMediaQueryObserver(component, options = {}) {
	return new MediaQueryObserver(component, options)
}

class MediaQueryObserver {
	constructor(component, options) {
		this._component = component
		this._options = options
		this._observerId = null
		this._callbackId = null
		this._disconnected = false
	}

	observe(condition, listener) {
		if (!isFunction(listener)) {
			throw new TypeError('MediaQueryObserver.observe listener must be a function')
		}
		if (this._observerId !== null) {
			throw new Error('MediaQueryObserver.observe can only be called once')
		}

		this._disconnected = false
		this._callbackId = callback.store((res = {}) => {
			if (res.observerId) {
				this._observerId = res.observerId
				if (this._disconnected) {
					invokeAPI('removeMediaQueryObserver', { observerId: res.observerId }, 'render')
					callback.remove(this._callbackId)
					this._callbackId = null
					return
				}
			}
			if (!this._disconnected && typeof res.matches === 'boolean') {
				listener.call(this, { matches: res.matches })
			}
		}, true)

		invokeAPI('addMediaQueryObserver', {
			moduleId: this._component.__id__,
			condition: normalizeCondition(condition),
			options: this._options,
			success: this._callbackId,
		}, 'render')
	}

	disconnect() {
		this._disconnected = true
		invokeAPI('removeMediaQueryObserver', {
			observerId: this._observerId,
		}, 'render')
		if (this._callbackId && this._observerId) {
			callback.remove(this._callbackId)
			this._callbackId = null
		}
	}
}
