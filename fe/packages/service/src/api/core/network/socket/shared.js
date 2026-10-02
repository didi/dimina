import { arrayBufferToBase64, base64ToArrayBuffer, callback } from '@dimina/common'
import { invokeAPI } from '@/api/common'

export { arrayBufferToBase64, base64ToArrayBuffer } from '@dimina/common'

export const ARRAY_BUFFER_BASE64_KEY = '__diminaArrayBufferBase64'

function isArrayBuffer(value) {
	return Object.prototype.toString.call(value) === '[object ArrayBuffer]'
}

export function toArrayBuffer(value) {
	if (isArrayBuffer(value)) return value
	// ArrayBuffer.isView 覆盖所有 TypedArray 和 DataView，包括底层是 SharedArrayBuffer
	// 的那些——按 value.buffer 的 brand 判定会把它们漏掉，视图就被当普通对象过桥了。
	// 统一把视图覆盖的那段字节复制到新的 ArrayBuffer：SharedArrayBuffer 本身不该跨桥，
	// 复制之后交出去的一定是普通 ArrayBuffer。
	if (ArrayBuffer.isView(value)) {
		const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
		const copy = new Uint8Array(bytes.length)
		copy.set(bytes)
		return copy.buffer
	}
	return null
}

export function encodeSocketMessage(value) {
	const buffer = toArrayBuffer(value)
	return buffer ? { [ARRAY_BUFFER_BASE64_KEY]: arrayBufferToBase64(buffer) } : value
}

export function decodeSocketMessageResult(value) {
	if (!value || typeof value !== 'object') return value
	const encoded = value.message
	if (!encoded || typeof encoded !== 'object' || encoded[ARRAY_BUFFER_BASE64_KEY] === undefined) return value
	return {
		...value,
		message: base64ToArrayBuffer(encoded[ARRAY_BUFFER_BASE64_KEY]),
	}
}

export function createSocketId(type) {
	return `${type}_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`
}

export function invokeSocketMethod(name, socketId, data = {}) {
	return invokeAPI(name, { socketId, ...data, keep: true })
}

export function createNativeEvent(onName, offName, baseParams = {}, transform = value => value) {
	const listeners = new Set()
	let callbackId
	let failureId
	let afterEmit

	function stopNative() {
		if (!callbackId) return
		const currentId = callbackId
		callbackId = undefined
		callback.remove(currentId)
		if (failureId) callback.remove(failureId)
		failureId = undefined
		invokeAPI(offName, { ...baseParams, callbackId: currentId, keep: true })
	}

	return {
		on(listener) {
			if (typeof listener !== 'function') return
			listeners.add(listener)
			if (callbackId) return

			const currentId = callback.store((value) => {
				if (failureId) callback.remove(failureId)
				failureId = undefined
				const result = transform(value)
				for (const current of [...listeners]) current(result)
				afterEmit?.()
			}, true)
			callbackId = currentId
			failureId = callback.store(() => {
				if (callbackId !== currentId) return
				callback.remove(currentId)
				if (failureId) callback.remove(failureId)
				callbackId = undefined
				failureId = undefined
			})
			try {
				return invokeAPI(onName, {
					...baseParams,
					callbackId: currentId,
					success: currentId,
					fail: failureId,
					keep: true,
				})
			}
			catch (error) {
				callback.remove(currentId)
				if (failureId) callback.remove(failureId)
				callbackId = undefined
				failureId = undefined
				throw error
			}
		},
		off(listener) {
			if (typeof listener === 'function') listeners.delete(listener)
			else listeners.clear()
			if (listeners.size === 0) return stopNative()
		},
		dispose({ notifyNative = false } = {}) {
			listeners.clear()
			if (notifyNative) return stopNative()
			if (callbackId) callback.remove(callbackId)
			if (failureId) callback.remove(failureId)
			callbackId = undefined
			failureId = undefined
		},
		hasListeners() {
			return listeners.size > 0
		},
		setAfterEmit(handler) {
			afterEmit = handler
		},
	}
}
