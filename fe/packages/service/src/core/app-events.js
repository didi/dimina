const listeners = {
	error: [],
	show: [],
	hide: [],
}

let appErrorHandler
let reportingError = false
let globalErrorHandlerInstalled = false

function eventMethodName(type, prefix) {
	const suffix = type === 'error'
		? 'Error'
		: type === 'show' ? 'AppShow' : 'AppHide'
	return `${prefix}${suffix}`
}

function addListener(type, listener) {
	if (typeof listener !== 'function') {
		console.error(`${eventMethodName(type, 'on')} should accept a function instead of ${typeof listener}`)
		return
	}
	listeners[type].push(listener)
}

function removeListener(type, listener) {
	// 与微信基础库一致：不传 listener（以及其它 falsy 值）时清空该事件的全部监听。
	if (!listener) {
		listeners[type] = []
		return
	}
	if (typeof listener !== 'function') {
		console.error(`${eventMethodName(type, 'off')} should accept a function instead of ${typeof listener}`)
		return
	}
	// 同一个函数可以重复 on；off(fn) 会移除这个函数对应的全部注册。
	listeners[type] = listeners[type].filter(item => item !== listener)
}

function invokeListener(listener, args, label) {
	try {
		listener(...args)
	}
	catch (error) {
		if (reportingError) {
			console.error(`[service] ${label} error:`, error)
		}
		else {
			reportAppError(error)
			console.error(`[service] ${label} error:`, error)
		}
	}
}

function emit(type, args, label) {
	// EventEmitter 在一次 emit 开始后固定本轮监听列表；监听器内部的 on/off
	// 只影响下一次事件。复制数组也避免一个监听器的异常或移除操作打断后续监听。
	for (const listener of [...listeners[type]]) {
		invokeListener(listener, args, label)
	}
}

export function onAppError(listener) {
	addListener('error', listener)
}

export function offAppError(listener) {
	removeListener('error', listener)
}

export function onAppShowEvent(listener) {
	addListener('show', listener)
}

export function offAppShowEvent(listener) {
	removeListener('show', listener)
}

export function onAppHideEvent(listener) {
	addListener('hide', listener)
}

export function offAppHideEvent(listener) {
	removeListener('hide', listener)
}

export function emitAppShow(options) {
	emit('show', [options], 'wx.onAppShow')
}

export function emitAppHide() {
	emit('hide', [], 'wx.onAppHide')
}

export function setAppErrorHandler(handler) {
	appErrorHandler = typeof handler === 'function' ? handler : undefined
}

export function formatAppError(error) {
	if (typeof error === 'string') {
		return error
	}
	if (error?.stack) {
		return String(error.stack)
	}
	if (error?.message) {
		return String(error.message)
	}
	try {
		const serialized = JSON.stringify(error)
		if (serialized !== undefined) {
			return serialized
		}
	}
	catch {}
	return String(error)
}

export function reportAppError(error) {
	const message = formatAppError(error)
	if (reportingError) {
		console.error('[service] error handler error:', error)
		return message
	}

	reportingError = true
	try {
		// 微信基础库的应用生命周期监听分为 internal/global 两组；internal
		// （App.onError）先于 global（wx.onError）。这里保持相同顺序。
		if (appErrorHandler) {
			invokeListener(appErrorHandler, [message], 'App.onError')
		}
		emit('error', [message], 'wx.onError')
	}
	finally {
		reportingError = false
	}
	return message
}

export function installGlobalErrorHandler() {
	if (globalErrorHandlerInstalled) {
		return
	}
	globalErrorHandlerInstalled = true

	const handleError = (eventOrMessage) => {
		reportAppError(eventOrMessage?.error || eventOrMessage?.message || eventOrMessage)
	}
	if (typeof globalThis.addEventListener === 'function') {
		globalThis.addEventListener('error', handleError)
		return
	}

	const previousOnError = globalThis.onerror
	globalThis.onerror = function (message, source, line, column, error) {
		handleError(error || message)
		if (typeof previousOnError === 'function') {
			return previousOnError.call(this, message, source, line, column, error)
		}
		return false
	}
}

// 仅供 runtime 重建和单元测试清理同一个 service 上下文中的全局状态。
export function resetAppEvents() {
	listeners.error = []
	listeners.show = []
	listeners.hide = []
	appErrorHandler = undefined
	reportingError = false
}
