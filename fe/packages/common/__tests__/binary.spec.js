import { afterEach, describe, expect, it, vi } from 'vitest'
import { arrayBufferToBase64, base64ToArrayBuffer } from '../src/core/binary'

afterEach(() => vi.unstubAllGlobals())

describe('binary bridge codec', () => {
	it.each(['', 'Zg==', 'Zm8=', 'Zm9v', 'AP9/gA=='])('round-trips all bytes and padding: %s', (encoded) => {
		const decoded = base64ToArrayBuffer(encoded)
		expect(arrayBufferToBase64(decoded)).toBe(encoded)
	})

	it('round-trips a full video frame without browser helpers', () => {
		vi.stubGlobal('btoa', undefined)
		vi.stubGlobal('atob', undefined)
		const bytes = Uint8Array.from({ length: 720 * 1080 * 4 }, (_, index) => index % 256)
		const decoded = new Uint8Array(base64ToArrayBuffer(arrayBufferToBase64(bytes.buffer)))
		expect(decoded.length).toBe(bytes.length)
		expect(decoded.every((byte, index) => byte === bytes[index])).toBe(true)
	})

	it('uses native binary codecs where available', () => {
		const encodeArrayBuffer = vi.fn(() => 'AP8=')
		const decodeArrayBuffer = vi.fn(() => new Uint8Array([0, 255]).buffer)
		vi.stubGlobal('DiminaServiceBridge', { encodeArrayBuffer, decodeArrayBuffer })
		const bytes = new Uint8Array([0, 255]).buffer
		expect(arrayBufferToBase64(bytes)).toBe('AP8=')
		expect(encodeArrayBuffer).toHaveBeenCalledWith(bytes)
		expect(new Uint8Array(base64ToArrayBuffer('AP8='))).toEqual(new Uint8Array([0, 255]))
	})
})
