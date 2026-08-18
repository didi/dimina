import { callback } from '@dimina/common'
import { invokeAPI } from '@/api/common'

export const ARRAY_BUFFER_BASE64_KEY = '__diminaArrayBufferBase64'

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const BASE64_LOOKUP = (() => {
	const lookup = {}
	for (let i = 0; i < BASE64_CHARS.length; i++) {
		lookup[BASE64_CHARS[i]] = i
	}
	return lookup
})()

function isArrayBuffer(value) {
	return Object.prototype.toString.call(value) === '[object ArrayBuffer]'
}

function toArrayBuffer(value) {
	if (isArrayBuffer(value)) {
		return value
	}
	if (value && value.buffer && isArrayBuffer(value.buffer)) {
		return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
	}
	return null
}

function arrayBufferToBase64(buffer) {
	const bytes = new Uint8Array(buffer)
	let result = ''
	let i = 0
	for (; i + 2 < bytes.length; i += 3) {
		result += BASE64_CHARS[bytes[i] >> 2]
		result += BASE64_CHARS[((bytes[i] & 3) << 4) | (bytes[i + 1] >> 4)]
		result += BASE64_CHARS[((bytes[i + 1] & 15) << 2) | (bytes[i + 2] >> 6)]
		result += BASE64_CHARS[bytes[i + 2] & 63]
	}
	if (i < bytes.length) {
		result += BASE64_CHARS[bytes[i] >> 2]
		if (i + 1 < bytes.length) {
			result += BASE64_CHARS[((bytes[i] & 3) << 4) | (bytes[i + 1] >> 4)]
			result += `${BASE64_CHARS[(bytes[i + 1] & 15) << 2]}=`
		}
		else {
			result += `${BASE64_CHARS[(bytes[i] & 3) << 4]}==`
		}
	}
	return result
}

function base64ToArrayBuffer(base64) {
	const clean = String(base64 || '').replace(/[\r\n\s]/g, '')
	if (!clean) {
		return new ArrayBuffer(0)
	}

	const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0
	const length = (clean.length * 3 / 4) - padding
	const bytes = new Uint8Array(length)
	let byteIndex = 0
	for (let i = 0; i < clean.length; i += 4) {
		const c1 = BASE64_LOOKUP[clean[i]]
		const c2 = BASE64_LOOKUP[clean[i + 1]]
		const c3 = clean[i + 2] === '=' ? 0 : BASE64_LOOKUP[clean[i + 2]]
		const c4 = clean[i + 3] === '=' ? 0 : BASE64_LOOKUP[clean[i + 3]]
		if (byteIndex < length) bytes[byteIndex++] = (c1 << 2) | (c2 >> 4)
		if (byteIndex < length) bytes[byteIndex++] = ((c2 & 15) << 4) | (c3 >> 2)
		if (byteIndex < length) bytes[byteIndex++] = ((c3 & 3) << 6) | c4
	}
	return bytes.buffer
}

export function encodeArrayBuffer(value) {
	const buffer = toArrayBuffer(value)
	if (!buffer) {
		return value
	}
	return { [ARRAY_BUFFER_BASE64_KEY]: arrayBufferToBase64(buffer) }
}

export function decodeArrayBuffer(value) {
	if (value && typeof value === 'object' && value[ARRAY_BUFFER_BASE64_KEY] !== undefined) {
		return base64ToArrayBuffer(value[ARRAY_BUFFER_BASE64_KEY])
	}
	return value
}

export function normalizeBluetoothDevice(device) {
	if (!device || typeof device !== 'object') {
		return device
	}
	const serviceData = {}
	for (const [uuid, value] of Object.entries(device.serviceData || {})) {
		serviceData[uuid] = decodeArrayBuffer(value)
	}
	return {
		...device,
		advertisData: decodeArrayBuffer(device.advertisData),
		serviceData,
	}
}

export function normalizeDeviceResult(result) {
	if (!result || !Array.isArray(result.devices)) {
		return result
	}
	return {
		...result,
		devices: result.devices.map(normalizeBluetoothDevice),
	}
}

export function normalizeCharacteristicResult(result) {
	if (!result || typeof result !== 'object') {
		return result
	}
	return {
		...result,
		value: decodeArrayBuffer(result.value),
	}
}

function withResultTransform(opts, transform) {
	if (!opts || typeof opts !== 'object') {
		return opts
	}
	const next = { ...opts }
	if (typeof opts.success === 'function') {
		next.success = result => opts.success(transform(result))
	}
	if (typeof opts.complete === 'function') {
		next.complete = result => opts.complete(transform(result))
	}
	return next
}

export function invokeBluetoothAPI(name, opts, { prepare = value => value, transform = value => value } = {}) {
	const result = invokeAPI(name, prepare(withResultTransform(opts, transform)))
	if (result && typeof result.then === 'function') {
		return result.then(transform)
	}
	return result
}

export function createBluetoothEvent(onName, offName, transform = value => value) {
	const listeners = new Map()
	return {
		on(listener) {
			if (typeof listener !== 'function' || listeners.has(listener)) {
				return
			}
			const wrapped = value => listener(transform(value))
			const callbackId = callback.store(wrapped, true)
			listeners.set(listener, callbackId)
			return invokeAPI(onName, { callbackId, success: callbackId, keep: true })
		},
		off(listener) {
			if (typeof listener === 'function') {
				const callbackId = listeners.get(listener)
				if (!callbackId) {
					return
				}
				listeners.delete(listener)
				callback.remove(callbackId)
				return invokeAPI(offName, { callbackId, keep: true })
			}

			for (const callbackId of listeners.values()) {
				callback.remove(callbackId)
			}
			listeners.clear()
			return invokeAPI(offName)
		},
	}
}
