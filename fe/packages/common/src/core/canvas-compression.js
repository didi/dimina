import { MAX_CANVAS_IMAGE_BYTES } from './canvas-limits'

// Tokens are little endian; payload words are copied as raw bits, including NaNs.
export function decodeCanvasRle32(encodedBuffer, byteLength) {
	if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > MAX_CANVAS_IMAGE_BYTES || byteLength % 4 !== 0) {
		throw new RangeError('invalid rle32 canvas byteLength')
	}
	const isView = ArrayBuffer.isView(encodedBuffer)
	if (!isView && Object.prototype.toString.call(encodedBuffer) !== '[object ArrayBuffer]') {
		throw new TypeError('rle32 canvas input must be an ArrayBuffer or view')
	}
	const bytes = isView
		? new Uint8Array(encodedBuffer.buffer, encodedBuffer.byteOffset, encodedBuffer.byteLength)
		: new Uint8Array(encodedBuffer)
	if (bytes.byteLength % 4 !== 0) throw new RangeError('truncated rle32 canvas packet')
	const tokens = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	const words = bytes.byteOffset % 4 === 0 ? new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4) : null
	const scratch = words ? null : new Uint32Array(1)
	const scratchBytes = scratch ? new Uint8Array(scratch.buffer) : null
	const output = new ArrayBuffer(byteLength)
	const outputBytes = new Uint8Array(output)
	const outputWords = new Uint32Array(output)
	let cursor = 0
	let written = 0
	while (cursor < bytes.byteLength) {
		const token = tokens.getUint32(cursor, true)
		cursor += 4
		const count = token & 0x7FFFFFFF
		if (count === 0) throw new RangeError('rle32 canvas token has zero words')
		if (count > (byteLength - written) / 4) throw new RangeError('rle32 canvas packet exceeds its declared size')
		const size = count * 4
		if (token & 0x80000000) {
			if (bytes.byteLength - cursor < 4) throw new RangeError('truncated rle32 canvas run')
			let word
			if (words) word = words[cursor / 4]
			else {
				scratchBytes.set(bytes.subarray(cursor, cursor + 4))
				word = scratch[0]
			}
			outputWords.fill(word, written / 4, written / 4 + count)
			cursor += 4
		}
		else {
			if (bytes.byteLength - cursor < size) throw new RangeError('truncated rle32 canvas literal')
			outputBytes.set(bytes.subarray(cursor, cursor + size), written)
			cursor += size
		}
		written += size
	}
	if (written !== byteLength) throw new RangeError('rle32 canvas packet is smaller than its declared size')
	return output
}
