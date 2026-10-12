import { describe, expect, it } from 'vitest'
import { decodeCanvasRle32 } from '../src/core/canvas-compression'
import { MAX_CANVAS_IMAGE_BYTES } from '../src/core/canvas-limits'

function packet(...segments) {
	const length = segments.reduce((sum, segment) => sum + 4 + segment.bytes.length, 0)
	const output = new Uint8Array(length)
	const tokens = new DataView(output.buffer)
	let cursor = 0
	for (const { run = false, count, bytes } of segments) {
		tokens.setUint32(cursor, (run ? 0x80000000 : 0) + count, true)
		output.set(bytes, cursor + 4)
		cursor += 4 + bytes.length
	}
	return output.buffer
}

describe('rle32 canvas decoder', () => {
	it('decodes mixed literal and run words as exact bytes into an independent buffer', () => {
		const encoded = packet(
			{ count: 2, bytes: [0, 1, 128, 255, 4, 5, 6, 7] },
			{ run: true, count: 3, bytes: [255, 0, 0, 255] },
			{ count: 1, bytes: [8, 9, 10, 11] },
		)
		const output = decodeCanvasRle32(encoded, 24)
		expect([...new Uint8Array(output)]).toEqual([
			0, 1, 128, 255, 4, 5, 6, 7,
			255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255,
			8, 9, 10, 11,
		])
		expect(output).not.toBe(encoded)
		new Uint8Array(encoded).fill(0)
		expect(new Uint8Array(output).at(-1)).toBe(11)
	})

	it('preserves Float32 NaN payloads, signed zero and infinity bit patterns', () => {
		const nan = [0x45, 0x23, 0xA1, 0x7F]
		const literal = [0, 0, 0, 0x80, 0, 0, 0x80, 0x7F]
		const encoded = packet({ run: true, count: 3, bytes: nan }, { count: 2, bytes: literal })
		expect([...new Uint8Array(decodeCanvasRle32(encoded, 20))]).toEqual([...nan, ...nan, ...nan, ...literal])
	})

	it.each(['Uint8Array', 'DataView', 'Uint32Array'])('reads only the declared %s view range', (type) => {
		const encoded = packet({ run: true, count: 3, bytes: [0, 128, 255, 7] })
		const backing = new Uint8Array(encoded.byteLength + 8).fill(99)
		backing.set(new Uint8Array(encoded), 4)
		const view = type === 'DataView' ? new DataView(backing.buffer, 4, encoded.byteLength)
			: type === 'Uint32Array' ? new Uint32Array(backing.buffer, 4, encoded.byteLength / 4)
				: new Uint8Array(backing.buffer, 4, encoded.byteLength)
		expect([...new Uint8Array(decodeCanvasRle32(view, 12))]).toEqual([0, 128, 255, 7, 0, 128, 255, 7, 0, 128, 255, 7])
	})

	it('supports an unaligned encoded view without changing payload bytes', () => {
		const encoded = packet({ run: true, count: 2, bytes: [1, 128, 255, 7] }, { count: 1, bytes: [8, 9, 10, 11] })
		const backing = new Uint8Array(encoded.byteLength + 2).fill(77)
		backing.set(new Uint8Array(encoded), 1)
		const view = new DataView(backing.buffer, 1, encoded.byteLength)
		expect([...new Uint8Array(decodeCanvasRle32(view, 12))]).toEqual([1, 128, 255, 7, 1, 128, 255, 7, 8, 9, 10, 11])
	})

	it('accepts the exact maximum output capacity and an empty packet for zero output', () => {
		const output = decodeCanvasRle32(packet({ run: true, count: MAX_CANVAS_IMAGE_BYTES / 4, bytes: [0, 128, 255, 7] }), MAX_CANVAS_IMAGE_BYTES)
		expect(output.byteLength).toBe(MAX_CANVAS_IMAGE_BYTES)
		expect([...new Uint8Array(output, output.byteLength - 4)]).toEqual([0, 128, 255, 7])
		expect(decodeCanvasRle32(new ArrayBuffer(0), 0).byteLength).toBe(0)
	})

	it.each([-4, 1, 3, 4.5, NaN, Infinity, MAX_CANVAS_IMAGE_BYTES + 4, '4'])('rejects invalid declared capacity %j', (size) => {
		expect(() => decodeCanvasRle32(new ArrayBuffer(0), size)).toThrow(/byteLength/)
	})

	it.each([0x7FFFFFFF, null, {}, [1, 2, 3, 4], 'AAAA'])('rejects non-buffer input without interpreting it as a typed-array allocation %j', (input) => {
		expect(() => decodeCanvasRle32(input, 0)).toThrow(/input/)
	})

	it.each([0, 0x80000000])('rejects zero-word token %j', (token) => {
		const encoded = new ArrayBuffer(4)
		new DataView(encoded).setUint32(0, token, true)
		expect(() => decodeCanvasRle32(encoded, 4)).toThrow(/zero words/)
	})

	it('rejects truncated tokens, run words and literal words', () => {
		expect(() => decodeCanvasRle32(new ArrayBuffer(3), 4)).toThrow(/truncated/)
		expect(() => decodeCanvasRle32(packet({ run: true, count: 1, bytes: [] }), 4)).toThrow(/truncated.*run/)
		expect(() => decodeCanvasRle32(packet({ count: 2, bytes: [1, 2, 3, 4] }), 8)).toThrow(/truncated.*literal/)
	})

	it('rejects output underflow, overflow and trailing packets rather than returning partial data', () => {
		expect(() => decodeCanvasRle32(packet({ run: true, count: 1, bytes: [1, 2, 3, 4] }), 8)).toThrow(/smaller/)
		expect(() => decodeCanvasRle32(packet({ run: true, count: 2, bytes: [1, 2, 3, 4] }), 4)).toThrow(/exceeds/)
		expect(() => decodeCanvasRle32(packet({ count: 0x7FFFFFFF, bytes: [] }), 4)).toThrow(/exceeds/)
		expect(() => decodeCanvasRle32(packet({ count: 1, bytes: [1, 2, 3, 4] }, { run: true, count: 1, bytes: [5, 6, 7, 8] }), 4)).toThrow(/exceeds/)
		expect(() => decodeCanvasRle32(new ArrayBuffer(0), 4)).toThrow(/smaller/)
	})
})
