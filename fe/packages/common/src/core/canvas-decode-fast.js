import { MAX_CANVAS_IMAGE_BYTES } from './canvas-limits'
import bytes from './canvas-decode-kernel-bytes'

const TEXT_BYTES = 2 * 1024 * 1024
const PACKED_BYTES = 1024 * 1024
const OUTPUT_BYTES = 4 * 1024 * 1024
const MEMORY_BYTES = 8 * 1024 * 1024
const MAX_BASE64_CHARS = Math.ceil(PACKED_BYTES / 3) * 4
let codec, attempted = false, busy = false

function getCodec() {
	if (attempted) return codec
	attempted = true
	try {
		if (typeof WebAssembly === 'undefined' || typeof TextEncoder === 'undefined'
			|| typeof TextEncoder.prototype.encodeInto !== 'function') return null
		// This is browser Wasm in Render. A missing SIMD/CSP/allocation capability
		// leaves the existing JS decoder available; WXWebAssembly is unaffected.
		const exports = new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports
		if (exports.memory.buffer.byteLength !== MEMORY_BYTES) return null
		codec = {
			exports, memory: new Uint8Array(exports.memory.buffer), encoder: new TextEncoder(),
			text: exports.text_ptr(), packed: exports.input_ptr(), output: exports.output_ptr(),
		}
	}
	catch { codec = null }
	return codec
}

// null selects the original decoder, including its whitespace/error behavior.
// The kernel validates the complete packet before returning an owned band.
export function decodeLargeCanvasRleBand(base64, total, width, height, priorRows, expectedWord) {
	if (typeof base64 !== 'string' || base64.length < 65536 || base64.length > MAX_BASE64_CHARS || busy
		|| !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0
		|| !Number.isSafeInteger(total) || total !== width * height * 4 || total > MAX_CANVAS_IMAGE_BYTES
		|| !Number.isSafeInteger(priorRows) || priorRows < 0 || priorRows > Math.floor(height / 2)
		|| !Number.isSafeInteger(expectedWord) || expectedWord < 0 || expectedWord > 0xFFFFFFFF) return null
	const maximumPrefix = width * Math.floor(height / 2) * 4
	if (!Number.isSafeInteger(maximumPrefix) || maximumPrefix > OUTPUT_BYTES) return null
	const c = getCodec()
	if (!c) return null
	busy = true
	const e = c.exports, m = c.memory
	let textWritten = Math.min(TEXT_BYTES, base64.length * 3)
	let prefix = 0
	try {
		const written = c.encoder.encodeInto(base64, m.subarray(c.text, c.text + TEXT_BYTES))
		textWritten = written.written
		if (written.read !== base64.length || written.written !== base64.length) return null
		const packed = e.decode_base64(written.written)
		if (packed < 8 || packed % 4) return null
		const packet = new DataView(m.buffer, c.packed, packed)
		const token = packet.getUint32(packed - 8, true), candidateWords = token & 0x7FFFFFFF
		if (!(token & 0x80000000) || !candidateWords || candidateWords > total / 4
			|| packet.getUint32(packed - 4, true) !== expectedWord) return null
		const rows = Math.max(priorRows, Math.ceil((total / 4 - candidateWords) / width))
		if (rows > height / 2) return null
		// Peeking only bounds work. Validate every token and confirm the suffix
		// really is that final run before accepting any pixel or tail proof.
		prefix = rows * width * 4
		if (e.decode(packed, total, prefix) !== 0 || (e.last_words() >>> 0) !== candidateWords
			|| (e.last_word() >>> 0) !== expectedWord) return null
		return { rows, buffer: m.slice(c.output, c.output + rows * width * 4).buffer }
	}
	catch { return null }
	finally {
		// No prior frame's pixels remain in reusable storage, including failures.
		m.fill(0, c.text, c.text + textWritten)
		m.fill(0, c.packed, c.packed + Math.min(PACKED_BYTES, Math.ceil(textWritten / 4) * 3))
		m.fill(0, c.output, c.output + prefix)
		busy = false
	}
}
