const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const BASE64_LOOKUP = Object.fromEntries([...BASE64_CHARS].map((char, index) => [char, index]))

export function arrayBufferToBase64(buffer) {
	const encode = globalThis.DiminaServiceBridge?.encodeArrayBuffer
	if (typeof encode === 'function') return encode(buffer)
	const bytes = new Uint8Array(buffer)
	if (typeof globalThis.btoa === 'function') {
		const chunks = []
		for (let i = 0; i < bytes.length; i += 8192) chunks.push(String.fromCharCode(...bytes.subarray(i, i + 8192)))
		return globalThis.btoa(chunks.join(''))
	}
	let result = ''
	let index = 0
	for (; index + 2 < bytes.length; index += 3) {
		result += BASE64_CHARS[bytes[index] >> 2]
		result += BASE64_CHARS[((bytes[index] & 3) << 4) | (bytes[index + 1] >> 4)]
		result += BASE64_CHARS[((bytes[index + 1] & 15) << 2) | (bytes[index + 2] >> 6)]
		result += BASE64_CHARS[bytes[index + 2] & 63]
	}
	if (index < bytes.length) {
		result += BASE64_CHARS[bytes[index] >> 2]
		if (index + 1 < bytes.length) {
			result += BASE64_CHARS[((bytes[index] & 3) << 4) | (bytes[index + 1] >> 4)]
			result += `${BASE64_CHARS[(bytes[index + 1] & 15) << 2]}=`
		}
		else {
			result += `${BASE64_CHARS[(bytes[index] & 3) << 4]}==`
		}
	}
	return result
}

export function base64ToArrayBuffer(base64) {
	const decode = globalThis.DiminaServiceBridge?.decodeArrayBuffer
	if (typeof decode === 'function') return decode(base64)
	const clean = String(base64 || '').replace(/[\r\n\s]/g, '')
	if (!clean) return new ArrayBuffer(0)
	if (typeof globalThis.atob === 'function') {
		const binary = globalThis.atob(clean)
		return Uint8Array.from(binary, char => char.charCodeAt(0)).buffer
	}

	const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0
	const length = (clean.length * 3 / 4) - padding
	const bytes = new Uint8Array(length)
	let byteIndex = 0
	for (let index = 0; index < clean.length; index += 4) {
		const first = BASE64_LOOKUP[clean[index]]
		const second = BASE64_LOOKUP[clean[index + 1]]
		const third = clean[index + 2] === '=' ? 0 : BASE64_LOOKUP[clean[index + 2]]
		const fourth = clean[index + 3] === '=' ? 0 : BASE64_LOOKUP[clean[index + 3]]
		if (byteIndex < length) bytes[byteIndex++] = (first << 2) | (second >> 4)
		if (byteIndex < length) bytes[byteIndex++] = ((second & 15) << 4) | (third >> 2)
		if (byteIndex < length) bytes[byteIndex++] = ((third & 3) << 6) | fourth
	}
	return bytes.buffer
}

