import { Buffer } from 'node:buffer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { arrayBufferToBase64, base64ToArrayBuffer } from '../src/core/binary'

const browserAtob = globalThis.atob

beforeEach(() => vi.stubGlobal('DiminaServiceBridge', undefined))
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

	it('decodes a large mixed-byte payload through the browser atob branch', () => {
		const atob = vi.fn(browserAtob)
		vi.stubGlobal('atob', atob)
		const bytes = Uint8Array.from({ length: 1024 * 1024 + 1 }, (_, index) => (index * 31 + (index >>> 8)) & 255)
		const encoded = Buffer.from(bytes).toString('base64')
		const decoded = new Uint8Array(base64ToArrayBuffer(encoded))
		expect(atob).toHaveBeenCalledExactlyOnceWith(encoded)
		expect(decoded.byteLength).toBe(bytes.byteLength)
		expect(decoded.every((byte, index) => byte === bytes[index])).toBe(true)
		expect(arrayBufferToBase64(decoded.buffer)).toBe(encoded)
	})

	it.each(['', ' \n\t\r '])('decodes empty input without invoking atob: %j', (encoded) => {
		const atob = vi.fn(browserAtob)
		vi.stubGlobal('atob', atob)
		expect(base64ToArrayBuffer(encoded).byteLength).toBe(0)
		expect(atob).not.toHaveBeenCalled()
	})

	it.each(['!', 'A', 'AA=A'])('preserves the browser atob error for invalid input: %s', (encoded) => {
		let browserError
		try { browserAtob(encoded) } catch (error) { browserError = error }
		expect(browserError).toBeInstanceOf(DOMException)
		const atob = vi.fn(() => { throw browserError })
		vi.stubGlobal('atob', atob)
		let decodedError
		try { base64ToArrayBuffer(encoded) } catch (error) { decodedError = error }
		expect(atob).toHaveBeenCalledExactlyOnceWith(encoded)
		expect(decodedError).toBe(browserError)
	})

	it('uses native binary codecs where available', () => {
		const encodeArrayBuffer = vi.fn(() => 'AP8=')
		const decodeArrayBuffer = vi.fn(() => new Uint8Array([0, 255]).buffer)
		vi.stubGlobal('DiminaServiceBridge', { encodeArrayBuffer, decodeArrayBuffer })
		const bytes = new Uint8Array([0, 255]).buffer
		expect(arrayBufferToBase64(bytes)).toBe('AP8=')
		expect(encodeArrayBuffer).toHaveBeenCalledWith(bytes)
		expect(new Uint8Array(base64ToArrayBuffer('AP8='))).toEqual(new Uint8Array([0, 255]))
		expect(decodeArrayBuffer).toHaveBeenCalledExactlyOnceWith('AP8=')
	})
})
