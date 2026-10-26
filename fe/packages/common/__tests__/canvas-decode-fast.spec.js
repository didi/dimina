import { afterEach, describe, expect, it, vi } from 'vitest'
import { decodeCanvasRle32PrefixWithTail } from '../src/core/canvas-compression'
import kernelBytes from '../src/core/canvas-decode-kernel-bytes'

const width = 256, height = 512, total = width * height * 4
function packet(rows = 240, phase = 1, tail = 0xFF000000, runWords = 8) {
	const words = []
	for (let i = 0; i < rows * width; i += runWords) words.push(0x80000000 + runWords, (0xFF000000 | i * phase) >>> 0)
	words.push(0x80000000 + (height - rows) * width, tail)
	const buffer = new Uint32Array(words).buffer
	return { buffer, base64: Buffer.from(buffer).toString('base64'), tail }
}
async function fresh() {
	vi.resetModules()
	return (await import('../src/core/canvas-decode-fast')).decodeLargeCanvasRleBand
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('large Canvas band decoder', () => {
	it('proves opacity for every SIMD lane and scalar remainder without changing decoded bytes', () => {
		const e = new WebAssembly.Instance(new WebAssembly.Module(kernelBytes)).exports
		const memory = new Uint8Array(e.memory.buffer)
		for (const count of [1, 2, 3, 4, 5, 8, 17]) {
			for (const alpha of [0, 1, 127, 128, 254, 255]) {
				for (let index = 0; index < count; index++) {
					const words = new Uint32Array(count + 3)
					words[0] = count
					for (let pixel = 0; pixel < count; pixel++) words[pixel + 1] = (0xFF000000 | pixel * 7919) >>> 0
					words[index + 1] = ((words[index + 1] & 0xFFFFFF) | (alpha << 24)) >>> 0
					words[count + 1] = 0x80000001
					words[count + 2] = 0xFF123456
					memory.set(new Uint8Array(words.buffer), e.input_ptr())
					expect(e.decode(words.byteLength, (count + 1) * 4, count * 4)).toBe(0)
					expect(e.last_opaque(), `pixel ${index}, count ${count}, alpha ${alpha}`).toBe(alpha === 255 ? 1 : 0)
					expect(Buffer.from(memory.subarray(e.output_ptr(), e.output_ptr() + count * 4)).equals(Buffer.from(words.buffer, 4, count * 4))).toBe(true)
				}
			}
		}
	})

	it('requires opaque run pixels and an opaque omitted tail before exposing the upload proof', async () => {
		const decode = await fresh(), opaque = packet(), translucent = packet(240, 1, 0x7F000000)
		expect(decode(opaque.base64, total, width, height, 240, opaque.tail).opaque).toBe(true)
		expect(decode(translucent.base64, total, width, height, 240, translucent.tail).opaque).toBe(false)
		const altered = new Uint32Array(opaque.buffer.slice(0))
		altered[1] = 0x7F123456
		expect(decode(Buffer.from(altered.buffer).toString('base64'), total, width, height, 240, opaque.tail).opaque).toBe(false)
	})

	it('decodes all binary values and padding lengths through bounded SIMD stores', () => {
		const e = new WebAssembly.Instance(new WebAssembly.Module(kernelBytes)).exports
		const m = new Uint8Array(e.memory.buffer), encoder = new TextEncoder()
		for (const length of [1, 2, 3, 11, 12, 13, 14, 15, 16, 255, 256, 257, 65535, 1048576]) {
			const input = Buffer.alloc(length)
			for (let i = 0; i < length; i++) input[i] = (i * 73 + (i >>> 8)) & 255
			const text = input.toString('base64')
			encoder.encodeInto(text, m.subarray(e.text_ptr()))
			const guard = m[e.input_ptr() + length]
			m[e.input_ptr() + length] = 0xA5
			expect(e.decode_base64(text.length)).toBe(length)
			expect(Buffer.from(m.slice(e.input_ptr(), e.input_ptr() + length)).equals(input)).toBe(true)
			expect(m[e.input_ptr() + length]).toBe(0xA5)
			m[e.input_ptr() + length] = guard
		}
		const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
		for (const position of [0, 15, 16, 127]) {
			for (let byte = 0; byte < 256; byte++) {
				m.fill(65, e.text_ptr(), e.text_ptr() + 132)
				m[e.text_ptr() + position] = byte
				expect(e.decode_base64(132) >= 0).toBe(alphabet.includes(String.fromCharCode(byte)))
			}
		}
		for (const position of [0, 1, 7, 15, 16, 31, 127]) {
			for (const bad of ['=', '!', '\u0080', '\n']) {
				const text = 'A'.repeat(position) + bad + 'A'.repeat(131 - position)
				encoder.encodeInto(text, m.subarray(e.text_ptr()))
				expect(e.decode_base64(text.length)).toBe(-1)
			}
		}
		for (const text of ['AB==', 'AAB=', 'AA=A', 'AAAAA===']) {
			encoder.encodeInto(text, m.subarray(e.text_ptr()))
			expect(e.decode_base64(text.length)).toBe(-1)
		}
	})

	it('decodes only the proven active rows while validating the complete packet', async () => {
		const Native = WebAssembly
		let kernelDecode
		vi.stubGlobal('WebAssembly', { Module: Native.Module, Instance: class {
			constructor(module) {
				const actual = new Native.Instance(module).exports
				kernelDecode = vi.fn((...args) => actual.decode(...args))
				this.exports = { ...actual, decode: kernelDecode }
			}
		} })
		const w = 512, h = 1024, active = 200, tail = 0xFF000000
		const words = []
		for (let i = 0; i < active * w; i += 8) words.push(0x80000008, (tail | i) >>> 0)
		words.push(0x80000000 + (h - active) * w, tail)
		const packed = new Uint32Array(words).buffer
		const decode = await fresh()
		const result = decode(Buffer.from(packed).toString('base64'), w * h * 4, w, h, 180, tail)
		expect(result.rows).toBe(active)
		expect(kernelDecode).toHaveBeenCalledWith(packed.byteLength, w * h * 4, active * w * 4)
		expect(Buffer.from(result.buffer).equals(Buffer.from(decodeCanvasRle32PrefixWithTail(packed, w * h * 4, active * w * 4).buffer))).toBe(true)
	})

	it('matches every prefix byte and clears a shrinking band without changing earlier returned frames', async () => {
		const decode = await fresh(), first = packet(240), second = packet(200, 7)
		const result = decode(first.base64, total, width, height, 250, first.tail)
		expect(result.rows).toBe(250)
		const expected = decodeCanvasRle32PrefixWithTail(first.buffer, total, 250 * width * 4).buffer
		expect(Buffer.from(result.buffer).equals(Buffer.from(expected))).toBe(true)
		const next = decode(second.base64, total, width, height, result.rows, second.tail)
		expect(Buffer.from(next.buffer).equals(Buffer.from(decodeCanvasRle32PrefixWithTail(second.buffer, total, 250 * width * 4).buffer))).toBe(true)
		expect(Buffer.from(result.buffer).equals(Buffer.from(expected))).toBe(true)
		expect(next.buffer).not.toBe(result.buffer)
	})

	it('retains raw word bits and validates the entire suffix before accepting its constant-tail proof', async () => {
		const decode = await fresh(), input = packet(240, 13, 0x7FA12345)
		expect(Buffer.from(decode(input.base64, total, width, height, 240, input.tail).buffer)
			.equals(Buffer.from(decodeCanvasRle32PrefixWithTail(input.buffer, total, 240 * width * 4).buffer))).toBe(true)
		const corrupt = new Uint32Array(input.buffer.slice(0))
		corrupt[corrupt.length - 2]++
		expect(decode(Buffer.from(corrupt.buffer).toString('base64'), total, width, height, 240, input.tail)).toBeNull()
		expect(() => decodeCanvasRle32PrefixWithTail(corrupt.buffer, total, 240 * width * 4)).toThrow()
		expect(decode(input.base64, total, width, height, 240, 0)).toBeNull()
		// A literal payload may end in bytes that resemble a valid run token.
		const literal = new Uint32Array(total / 4 + 1).fill(0xFF000001)
		literal[0] = total / 4
		literal[literal.length - 2] = 0x80000000 + total / 8
		literal[literal.length - 1] = input.tail
		expect(decode(Buffer.from(literal.buffer).toString('base64'), total, width, height, 240, input.tail)).toBeNull()
	})

	it('bounds reusable storage at 8 MiB and clears text, packed bytes and output on success and failure', async () => {
		const Native = WebAssembly
		let exports
		vi.stubGlobal('WebAssembly', { ...Native, Module: Native.Module, Instance: class extends Native.Instance {
			constructor(module) { super(module); exports = this.exports }
		} })
		const decode = await fresh(), input = packet()
		expect(decode(input.base64, total, width, height, 240, input.tail)).not.toBeNull()
		expect(exports.memory.buffer.byteLength).toBe(8 * 1024 * 1024)
		const assertCleared = () => {
			const memory = new Uint8Array(exports.memory.buffer)
			for (const [offset, size] of [[exports.text_ptr(), 2 * 1024 * 1024], [exports.input_ptr(), 1024 * 1024], [exports.output_ptr(), 4 * 1024 * 1024]]) {
				expect(memory.subarray(offset, offset + size).some(byte => byte !== 0)).toBe(false)
			}
		}
		assertCleared()
		expect(decode(input.base64.slice(0, -1) + '!', total, width, height, 240, input.tail)).toBeNull()
		assertCleared()
	})

	it('falls back for unsupported browser Wasm and retries no allocation for later frames', async () => {
		const Module = vi.fn(() => { throw new Error('Wasm blocked by CSP or unsupported SIMD') })
		vi.stubGlobal('WebAssembly', { Module, Instance: WebAssembly.Instance })
		const decode = await fresh(), input = packet()
		for (let i = 0; i < 3; i++) expect(decode(input.base64, total, width, height, 240, input.tail)).toBeNull()
		expect(Module).toHaveBeenCalledTimes(1)
	})

	it('leaves small, noncanonical, malformed and over-budget inputs to the existing decoder', async () => {
		const decode = await fresh(), input = packet()
		for (const encoded of ['AAAA', `=${input.base64.slice(1)}`, `\uD800${input.base64.slice(1)}`, input.base64.slice(0, -4), input.base64 + '\n']) {
			expect(decode(encoded, total, width, height, 240, input.tail)).toBeNull()
		}
		for (const [bytes, w, h, rows, word] of [[total + 4, width, height, 240, input.tail], [total, width, height, 257, input.tail],
			[total, width, height, 240, -1], [total, Number.NaN, height, 240, input.tail], [64 * 1024 * 1024, 4096, 4096, 1, input.tail]]) {
			expect(decode(input.base64, bytes, w, h, rows, word)).toBeNull()
		}
	})

	it('does not expose shared scratch bytes during a reentrant encoder call', async () => {
		const decode = await fresh(), input = packet()
		const original = TextEncoder.prototype.encodeInto
		let nested
		vi.spyOn(TextEncoder.prototype, 'encodeInto').mockImplementation(function (source, target) {
			nested = decode(input.base64, total, width, height, 240, input.tail)
			return original.call(this, source, target)
		})
		expect(decode(input.base64, total, width, height, 240, input.tail)).not.toBeNull()
		expect(nested).toBeNull()
	})
})


describe('synchronous Canvas band consumption', () => {
	it('consumes all current bytes from text and offset binary inputs, then clears the borrowed view', async () => {
		vi.resetModules()
		const { decodeLargeCanvasRleBand: decode, consumeLargeCanvasRleBand: consume } = await import('../src/core/canvas-decode-fast')
		const input = packet(240, 1, 0xFF000000, 4), expected = Buffer.from(decodeCanvasRle32PrefixWithTail(input.buffer, total, 240 * width * 4).buffer)
		const owned = decode(input.base64, total, width, height, 240, input.tail)
		const offset = new Uint8Array(input.buffer.byteLength + 6).fill(0xAB)
		offset.set(new Uint8Array(input.buffer), 3)
		for (const source of [input.base64, offset.subarray(3, offset.length - 3)]) {
			let borrowed
			const marker = {}
			const result = consume(source, total, width, height, 240, input.tail, band => {
				borrowed = band.pixels
				expect(band.rows).toBe(240)
				expect(band.opaque).toBe(true)
				expect(Buffer.from(band.pixels).equals(expected)).toBe(true)
				return marker
			})
			expect(result.value).toBe(marker)
			expect(borrowed.some(byte => byte !== 0)).toBe(false)
			expect(Buffer.from(owned.buffer).equals(expected)).toBe(true)
		}
		expect([...offset.subarray(0, 3), ...offset.subarray(-3)]).toEqual(Array.from({ length: 6 }, () => 0xAB))
	})
	it('clears scratch on consumer exceptions, rejects reentry and accepts the next upload', async () => {
		vi.resetModules()
		const { consumeLargeCanvasRleBand: consume } = await import('../src/core/canvas-decode-fast')
		const input = packet(), failure = new Error('driver upload failed'), nested = vi.fn()
		let borrowed
		expect(() => consume(input.base64, total, width, height, 240, input.tail, band => {
			borrowed = band.pixels
			expect(consume(input.base64, total, width, height, 240, input.tail, nested)).toBeNull()
			throw failure
		})).toThrow(failure)
		expect(nested).not.toHaveBeenCalled()
		expect(borrowed.some(byte => byte !== 0)).toBe(false)
		const next = vi.fn()
		expect(consume(input.base64, total, width, height, 240, input.tail, next)).not.toBeNull()
		expect(next).toHaveBeenCalledOnce()
	})
	it('never calls the consumer for a corrupt omitted suffix or unavailable SIMD', async () => {
		vi.resetModules()
		let { consumeLargeCanvasRleBand: consume } = await import('../src/core/canvas-decode-fast')
		const input = packet(), corrupt = new Uint32Array(input.buffer.slice(0)), callback = vi.fn()
		corrupt[corrupt.length - 2]++
		expect(consume(new Uint8Array(corrupt.buffer), total, width, height, 240, input.tail, callback)).toBeNull()
		expect(callback).not.toHaveBeenCalled()
		vi.stubGlobal('WebAssembly', { Module: vi.fn(() => { throw new Error('SIMD unavailable') }) })
		vi.resetModules()
		;({ consumeLargeCanvasRleBand: consume } = await import('../src/core/canvas-decode-fast'))
		expect(consume(input.base64, total, width, height, 240, input.tail, callback)).toBeNull()
		expect(callback).not.toHaveBeenCalled()
	})
	it('clears bytes written by a Wasm decoder that throws before returning', async () => {
		const Native = WebAssembly
		let exports
		vi.stubGlobal('WebAssembly', { Module: Native.Module, Instance: class {
			constructor(module) {
				exports = new Native.Instance(module).exports
				this.exports = { ...exports, decode_base64: length => { exports.decode_base64(length); throw new Error('decoder failed') } }
			}
		} })
		vi.resetModules()
		const { consumeLargeCanvasRleBand: consume } = await import('../src/core/canvas-decode-fast')
		const input = packet(), callback = vi.fn()
		expect(consume(input.base64, total, width, height, 240, input.tail, callback)).toBeNull()
		expect(callback).not.toHaveBeenCalled()
		const memory = new Uint8Array(exports.memory.buffer)
		for (const [start, size] of [[exports.text_ptr(), 2097152], [exports.input_ptr(), 1048576], [exports.output_ptr(), 4194304]]) {
			expect(memory.subarray(start, start + size).some(byte => byte !== 0)).toBe(false)
		}
	})
})
