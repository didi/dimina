import { describe, expect, it, vi } from 'vitest'
import { CanvasTextureUpload } from '../src/core/canvas-texture-upload.js'

const GL = {
	NO_ERROR: 0, INVALID_ENUM: 0x500, INVALID_VALUE: 0x501, INVALID_OPERATION: 0x502, OUT_OF_MEMORY: 0x505,
	CONTEXT_LOST_WEBGL: 0x9242, TEXTURE_2D: 0xDE1, TEXTURE0: 0x84C0,
	RGBA: 0x1908, UNSIGNED_BYTE: 0x1401, VERSION: 0x1F02,
	MAX_COMBINED_TEXTURE_IMAGE_UNITS: 0x8B4D, UNPACK_ALIGNMENT: 0xCF5,
	UNPACK_FLIP_Y_WEBGL: 0x9240, UNPACK_PREMULTIPLY_ALPHA_WEBGL: 0x9241,
	UNPACK_COLORSPACE_CONVERSION_WEBGL: 0x9243, BROWSER_DEFAULT_WEBGL: 0x9244,
	FRAMEBUFFER: 0x8D40, COLOR_ATTACHMENT0: 0x8CE0,
}

function frame(width = 4, height = 8, activeRows = 1, color = [73, 19, 201, 255], tail = [0, 0, 0, 255]) {
	const bytes = new Uint8Array(width * height * 4)
	for (let offset = 0; offset < bytes.length; offset += 4) bytes.set(tail, offset)
	for (let offset = 0; offset < activeRows * width * 4; offset += 4) bytes.set(color, offset)
	return bytes
}

function fullArgs(bytes, width = 4, height = 8) {
	return [GL.TEXTURE_2D, 0, GL.RGBA, width, height, 0, GL.RGBA, GL.UNSIGNED_BYTE, bytes]
}

// An independent GL storage model consumes the actual upload arguments. It
// checks the resulting complete texture, not the optimizer's internal proof.
function context() {
	const textures = new Set()
	const images = new Map()
	const bindings = new Map()
	const errors = []
	let active = GL.TEXTURE0
	let sequence = 0
	let failImage = []
	let failSub = []
	let failCreate = false
	let lost = false
	let flip = false
	const unpackBytes = (bytes, width, height) => {
		const input = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
		if (!flip) return input.slice()
		const output = new Uint8Array(input.length)
		for (let row = 0; row < height; row++) {
			output.set(input.subarray(row * width * 4, (row + 1) * width * 4), (height - row - 1) * width * 4)
		}
		return output
	}
	const ctx = {
		...GL,
		maxUnits: 8,
		getParameter: vi.fn(pname => pname === GL.MAX_COMBINED_TEXTURE_IMAGE_UNITS ? ctx.maxUnits : pname === GL.VERSION ? 'WebGL 1.0 mock' : null),
		getError: vi.fn(() => errors.shift() ?? GL.NO_ERROR),
		isContextLost: vi.fn(() => lost),
		createTexture: vi.fn(() => {
			if (failCreate || lost) { errors.push(lost ? GL.CONTEXT_LOST_WEBGL : GL.OUT_OF_MEMORY); return null }
			const texture = { id: ++sequence }
			textures.add(texture)
			return texture
		}),
		activeTexture: vi.fn(value => {
			const unit = Number(value) >>> 0
			if (unit >= GL.TEXTURE0 && unit < GL.TEXTURE0 + ctx.maxUnits) active = unit
			else errors.push(GL.INVALID_ENUM)
		}),
		bindTexture: vi.fn((target, texture) => {
			if ((Number(target) >>> 0) !== GL.TEXTURE_2D) { errors.push(GL.INVALID_ENUM); return }
			if (texture !== null && !textures.has(texture)) { errors.push(GL.INVALID_OPERATION); return }
			bindings.set(active, texture)
		}),
		pixelStorei: vi.fn((pname, param) => {
			if ((Number(pname) >>> 0) === GL.UNPACK_FLIP_Y_WEBGL) flip = Boolean(Number(param) | 0)
		}),
		deleteTexture: vi.fn(texture => {
			textures.delete(texture)
			images.delete(texture)
			for (const [unit, bound] of bindings) if (bound === texture) bindings.set(unit, null)
		}),
		texImage2D: vi.fn((...args) => {
			const texture = bindings.get(active)
			if (lost) { errors.push(GL.CONTEXT_LOST_WEBGL); return }
			if (!texture || !textures.has(texture)) { errors.push(GL.INVALID_OPERATION); return }
			if (failImage.length) { errors.push(...failImage); failImage = []; return }
			let width = args[3], height = args[4], bytes = args[8]
			if (args.length === 6) ({ width, height, data: bytes } = args[5])
			if (Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && ArrayBuffer.isView(bytes)
				&& bytes.byteLength === width * height * 4) {
				images.set(texture, { width, height, bytes: unpackBytes(bytes, width, height) })
			}
		}),
		texSubImage2D: vi.fn((target, level, x, y, width, height, format, type, bytes) => {
			if (lost) { errors.push(GL.CONTEXT_LOST_WEBGL); return }
			if (failSub.length) { errors.push(...failSub); failSub = []; return }
			const image = images.get(bindings.get(active))
			if (!image || x < 0 || y < 0 || x + width > image.width || y + height > image.height) {
				errors.push(GL.INVALID_OPERATION); return
			}
			const unpacked = unpackBytes(bytes, width, height)
			for (let row = 0; row < height; row++) {
				image.bytes.set(unpacked.subarray(row * width * 4, (row + 1) * width * 4), ((y + row) * image.width + x) * 4)
			}
		}),
		framebufferTexture2D: vi.fn(), framebufferTextureLayer: vi.fn(), generateMipmap: vi.fn(),
		copyTexImage2D: vi.fn(), copyTexSubImage2D: vi.fn(), compressedTexImage2D: vi.fn(),
		compressedTexSubImage2D: vi.fn(), texStorage2D: vi.fn(), drawArrays: vi.fn(),
		pixels: texture => images.get(texture)?.bytes,
		failNextImage: (...codes) => { failImage = codes },
		failNextSub: (...codes) => { failSub = codes },
		failNextCreate: () => { failCreate = true },
		raise: (...codes) => errors.push(...codes),
		lose: () => { lost = true },
		recover: () => { lost = false; active = GL.TEXTURE0; flip = false; bindings.clear(); textures.clear(); images.clear(); errors.length = 0 },
	}
	return ctx
}

function harness({ maxEntries, actualType = 'webgl', register = true } = {}) {
	const helper = new CanvasTextureUpload(maxEntries === undefined ? undefined : { maxEntries })
	const gl = context()
	if (register) helper.register(gl, actualType)
	const call = (method, ...args) => helper.invoke(gl, method, args, () => gl[method](...args))
	const texture = call('createTexture')
	call('bindTexture', GL.TEXTURE_2D, texture)
	return { helper, gl, call, texture, upload: (bytes, width = 4, height = 8) => call('texImage2D', ...fullArgs(bytes, width, height)) }
}

function rleWire(width, height, rows, color = [9, 80, 211, 255], tail = [0, 0, 0, 255]) {
	const literalBytes = rows * width * 4
	const encoded = new Uint8Array(literalBytes + 12)
	const view = new DataView(encoded.buffer)
	view.setUint32(0, literalBytes / 4, true)
	for (let offset = 4; offset < literalBytes + 4; offset += 4) encoded.set(color, offset)
	view.setUint32(literalBytes + 4, 0x80000000 + (height - rows) * width, true)
	encoded.set(tail, literalBytes + 8)
	return { __canvasTypedArray: 'Uint8Array', encoding: 'rle32-v1', byteLength: width * height * 4,
		base64: Buffer.from(encoded).toString('base64') }
}

describe('compressed constant-tail bands', () => {
	it('preserves every texture byte for a large decoded band that grows and shrinks', () => {
		const width = 256, height = 512
		const f = harness()
		f.upload(frame(width, height, 200), width, height)
		for (const rows of [240, 210, 250, 180]) {
			const wire = rleWire(width, height, rows)
			expect(wire.base64.length).toBeGreaterThan(65536)
			const upload = f.helper.prepareRleUpload(f.gl, fullArgs(wire, width, height))
			expect(upload).toBeTypeOf('function')
			upload()
			// Compare the complete texture without a matcher traversal per byte.
			const actual = Buffer.from(f.gl.pixels(f.texture))
			const expected = Buffer.from(frame(width, height, rows, [9, 80, 211, 255]))
			expect(actual.equals(expected), `complete texture after ${rows} active rows`).toBe(true)
		}
		expect(f.gl.texImage2D).toHaveBeenCalledTimes(1)
		expect(f.gl.texSubImage2D).toHaveBeenCalledTimes(4)
		expect(f.helper.cachedBytes).toBe(0)
	})

	it('decodes only the active prefix and preserves the complete texture while growing and shrinking', () => {
		const f = harness(); f.upload(frame())
		for (const rows of [3, 1, 4, 2]) {
			const invoke = f.helper.prepareRleUpload(f.gl, fullArgs(rleWire(4, 8, rows)))
			expect(invoke).toBeTypeOf('function'); invoke()
			expect(f.gl.pixels(f.texture)).toEqual(frame(4, 8, rows, [9, 80, 211, 255]))
		}
		expect(f.gl.texSubImage2D.mock.calls.map(args => args[8].byteLength)).toEqual([48, 48, 64, 64])
	})
	it('requires a successful initial full upload', () => {
		const f = harness()
		expect(f.helper.prepareRleUpload(f.gl, fullArgs(rleWire(4, 8, 1)))).toBeNull()
		f.gl.failNextImage(GL.OUT_OF_MEMORY); f.upload(frame())
		expect(f.helper.prepareRleUpload(f.gl, fullArgs(rleWire(4, 8, 1)))).toBeNull()
		expect(f.gl.texSubImage2D).not.toHaveBeenCalled()
	})
	it('falls back for a changed tail, excessive active area or changed unpack flags', () => {
		const f = harness(); f.upload(frame())
		expect(f.helper.prepareRleUpload(f.gl, fullArgs(rleWire(4, 8, 1, [1, 2, 3, 255], [8, 9, 10, 255])))).toBeNull()
		expect(f.helper.prepareRleUpload(f.gl, fullArgs(rleWire(4, 8, 5)))).toBeNull()
		f.call('pixelStorei', GL.UNPACK_FLIP_Y_WEBGL, true)
		expect(f.helper.prepareRleUpload(f.gl, fullArgs(rleWire(4, 8, 1)))).toBeNull()
	})
	it('cannot optimize framebuffer-attached or foreign textures', () => {
		const f = harness(); f.upload(frame())
		f.call('framebufferTexture2D', GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, f.texture, 0)
		expect(f.helper.prepareRleUpload(f.gl, fullArgs(rleWire(4, 8, 1)))).toBeNull()
	})
	it('checks the complete RLE packet before the real upload, including the omitted suffix', () => {
		const f = harness(); f.upload(frame())
		const wire = rleWire(4, 8, 1), encoded = Buffer.from(wire.base64, 'base64')
		encoded.writeUInt32LE(0x80000000 + 32, 20); wire.base64 = encoded.toString('base64')
		expect(() => f.helper.prepareRleUpload(f.gl, fullArgs(wire))).toThrow(/exceeds/)
		expect(f.gl.texSubImage2D).not.toHaveBeenCalled()
	})
	it('does not mistake literal pixel bits for a final run token', () => {
		const f = harness(); f.upload(frame())
		const encoded = new Uint8Array(4 + 4 * 8 * 4)
		const view = new DataView(encoded.buffer)
		view.setUint32(0, 32, true)
		view.setUint32(encoded.length - 8, 0x80000000 + 28, true)
		view.setUint32(encoded.length - 4, 0xFF000000, true)
		const wire = { __canvasTypedArray: 'Uint8Array', encoding: 'rle32-v1', byteLength: 128,
			base64: Buffer.from(encoded).toString('base64') }
		expect(f.helper.prepareRleUpload(f.gl, fullArgs(wire))).toBeNull()
		expect(f.gl.texSubImage2D).not.toHaveBeenCalled()
	})
	it('retains maximum attempted rows after an upload failure', () => {
		const f = harness(); f.upload(frame())
		f.gl.failNextSub(GL.OUT_OF_MEMORY)
		f.helper.prepareRleUpload(f.gl, fullArgs(rleWire(4, 8, 4)))()
		f.helper.prepareRleUpload(f.gl, fullArgs(rleWire(4, 8, 1)))()
		expect(f.gl.texSubImage2D.mock.calls.map(args => args[5])).toEqual([4, 4])
		expect(f.gl.pixels(f.texture)).toEqual(frame(4, 8, 1, [9, 80, 211, 255]))
	})
	it.each(['byteLength', '__canvasTypedArray', 'encoding'])('rejects incompatible wire field %s', (field) => {
		const f = harness(); f.upload(frame())
		const wire = { ...rleWire(4, 8, 1), [field]: 'wrong' }
		expect(f.helper.prepareRleUpload(f.gl, fullArgs(wire))).toBeNull()
	})
})

describe('CanvasTextureUpload constant-tail bands', () => {
	it('allocates the first full image, then uploads a top band with exactly the current pixels', () => {
		const { gl, texture, upload } = harness()
		upload(frame())
		const next = frame(4, 8, 2, [2, 101, 17, 255])
		upload(next)
		expect(gl.texImage2D).toHaveBeenCalledTimes(1)
		expect(gl.texSubImage2D).toHaveBeenCalledTimes(1)
		expect(gl.texSubImage2D.mock.calls[0].slice(0, 8)).toEqual([GL.TEXTURE_2D, 0, 0, 0, 4, 2, GL.RGBA, GL.UNSIGNED_BYTE])
		expect(gl.texSubImage2D.mock.calls[0][8]).toEqual(next.subarray(0, 32))
		expect(gl.pixels(texture)).toEqual(next)
	})

	it('clears rows previously active even after the current active band shrinks', () => {
		const { gl, texture, upload } = harness()
		upload(frame(4, 8, 1))
		upload(frame(4, 8, 4))
		const smaller = frame(4, 8, 1, [1, 2, 3, 255])
		upload(smaller)
		expect(gl.texSubImage2D.mock.calls.map(args => args[5])).toEqual([4, 4])
		expect(gl.pixels(texture)).toEqual(smaller)
	})

	it('retains the attempted maximum after an OOM so the next frame restores the entire band', () => {
		const { helper, gl, texture, upload } = harness()
		upload(frame())
		gl.failNextSub(GL.OUT_OF_MEMORY)
		upload(frame(4, 8, 3))
		const next = frame(4, 8, 0)
		upload(next)
		expect(gl.texSubImage2D.mock.calls.map(args => args[5])).toEqual([3, 3])
		expect(gl.pixels(texture)).toEqual(next)
		expect(helper.drainErrors(gl)).toEqual([])
		expect(gl.getError).toHaveBeenCalledTimes(1)
		expect(gl.getError()).toBe(GL.OUT_OF_MEMORY)
	})

	it('uses an arbitrary opaque constant tail, and skips a frame only when its historical band is empty', () => {
		const { gl, texture, upload } = harness()
		const constant = frame(4, 8, 0, undefined, [29, 71, 97, 255])
		upload(constant)
		upload(constant.slice())
		expect(gl.texImage2D).toHaveBeenCalledTimes(1)
		expect(gl.texSubImage2D).not.toHaveBeenCalled()
		expect(gl.getError).toHaveBeenCalledTimes(1)
		expect(gl.pixels(texture)).toEqual(constant)
	})

	it('starts uploading when an initially constant image gains active pixels', () => {
		const { gl, texture, upload } = harness()
		upload(frame(4, 8, 0))
		const next = frame(4, 8, 2)
		upload(next)
		expect(gl.texSubImage2D.mock.calls[0][5]).toBe(2)
		expect(gl.pixels(texture)).toEqual(next)
	})

	it('includes a partially active row and accepts exactly half the image height', () => {
		const { gl, texture, upload } = harness()
		upload(frame(4, 8, 0))
		const next = frame(4, 8, 0)
		next.set([9, 7, 4, 255], (3 * 4 + 2) * 4)
		upload(next)
		expect(gl.texSubImage2D.mock.calls[0][5]).toBe(4)
		expect(gl.pixels(texture)).toEqual(next)
	})

	it('uploads a changed tail or oversized band in full, then confirms a new proof before resuming', () => {
		for (const changed of [frame(4, 8, 1, undefined, [3, 5, 8, 255]), frame(4, 8, 5)]) {
			const { gl, texture, upload } = harness()
			upload(frame())
			upload(changed)
			const originalTail = frame(4, 8, 1, [4, 3, 2, 255])
			upload(originalTail)
			expect(gl.texImage2D).toHaveBeenCalledTimes(3)
			expect(gl.texSubImage2D).not.toHaveBeenCalled()
			expect(gl.pixels(texture)).toEqual(originalTail)
			const next = frame(4, 8, 2, [9, 8, 7, 255])
			upload(next)
			expect(gl.texSubImage2D).toHaveBeenCalledTimes(1)
			expect(gl.pixels(texture)).toEqual(next)
		}
	})

	it.each([1, 2, 3])('handles exact unaligned byte views at offset %i without including adjacent bytes', offset => {
		const { gl, texture, upload } = harness()
		const view = bytes => {
			const storage = new Uint8Array(bytes.length + offset + 7).fill(0xE7)
			storage.set(bytes, offset)
			return storage.subarray(offset, offset + bytes.length)
		}
		upload(view(frame()))
		const next = view(frame(4, 8, 2, [83, 17, 199, 255]))
		upload(next)
		expect(gl.texSubImage2D.mock.calls[0][8].byteLength).toBe(32)
		expect(gl.pixels(texture)).toEqual(new Uint8Array(next))
	})

	it('accepts clamped byte views and immutable premultiply state', () => {
		const { gl, texture, call, upload } = harness()
		call('pixelStorei', GL.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
		upload(new Uint8ClampedArray(frame()))
		const next = new Uint8ClampedArray(frame(4, 8, 2))
		upload(next)
		expect(gl.texSubImage2D).toHaveBeenCalledTimes(1)
		expect(gl.pixels(texture)).toEqual(new Uint8Array(next))
	})

	it.each([GL.UNPACK_ALIGNMENT, GL.UNPACK_PREMULTIPLY_ALPHA_WEBGL, GL.UNPACK_COLORSPACE_CONVERSION_WEBGL])('uses the original upload after unpack flag %i changes', pname => {
		const { gl, call, upload } = harness()
		upload(frame())
		call('pixelStorei', pname, pname === GL.UNPACK_ALIGNMENT ? 8 : pname === GL.UNPACK_PREMULTIPLY_ALPHA_WEBGL ? true : 0)
		upload(frame(4, 8, 2))
		expect(gl.texImage2D).toHaveBeenCalledTimes(2)
		expect(gl.texSubImage2D).not.toHaveBeenCalled()
	})

	it('does not optimize flipped rows or row widths incompatible with the real unpack alignment', () => {
		for (const flipped of [true, false]) {
			const { gl, call, upload } = harness()
			call('pixelStorei', flipped ? GL.UNPACK_FLIP_Y_WEBGL : GL.UNPACK_ALIGNMENT, flipped ? true : 8)
			const width = flipped ? 4 : 3
			upload(frame(width, 8, 1), width)
			upload(frame(width, 8, 2), width)
			expect(gl.texImage2D).toHaveBeenCalledTimes(2)
			expect(gl.texSubImage2D).not.toHaveBeenCalled()
		}
	})

	it('keeps independent proofs and pixels for multiple units and textures', () => {
		const { helper, gl, texture: first, call, upload } = harness()
		upload(frame())
		call('activeTexture', GL.TEXTURE0 + 1)
		const second = call('createTexture')
		call('bindTexture', GL.TEXTURE_2D, second)
		upload(frame(4, 8, 2, undefined, [11, 12, 13, 255]))
		const nextSecond = frame(4, 8, 0, undefined, [11, 12, 13, 255])
		upload(nextSecond)
		call('activeTexture', GL.TEXTURE0)
		const nextFirst = frame(4, 8, 3, [9, 8, 7, 255])
		upload(nextFirst)
		expect(gl.pixels(first)).toEqual(nextFirst)
		expect(gl.pixels(second)).toEqual(nextSecond)
		expect(gl.texImage2D).toHaveBeenCalledTimes(2)
		expect(gl.texSubImage2D).toHaveBeenCalledTimes(2)
		expect(helper.cachedBytes).toBe(0)
	})

	it.each([GL.TEXTURE0 + 99, GL.TEXTURE0 + 1.5, String(GL.TEXTURE0 + 1)])('does not reuse stale proofs after an uncertain activeTexture %s and a raw upload', value => {
		const { gl, texture: first, call, upload } = harness()
		upload(frame())
		call('activeTexture', GL.TEXTURE0 + 1)
		const second = call('createTexture')
		call('bindTexture', GL.TEXTURE_2D, second)
		upload(frame())
		call('activeTexture', GL.TEXTURE0)
		call('activeTexture', value)
		upload(frame(4, 8, 3))
		const affected = value === GL.TEXTURE0 + 99 ? first : second
		call('activeTexture', value === GL.TEXTURE0 + 99 ? GL.TEXTURE0 : GL.TEXTURE0 + 1)
		const next = frame(4, 8, 0)
		upload(next)
		expect(gl.pixels(affected)).toEqual(next)
	})

	it('keeps pixels correct when the driver rejects binding an unowned texture', () => {
		const { gl, texture, call, upload } = harness()
		upload(frame())
		call('bindTexture', GL.TEXTURE_2D, { invalid: true })
		upload(frame(4, 8, 3))
		call('bindTexture', GL.TEXTURE_2D, texture)
		const next = frame(4, 8, 0)
		upload(next)
		expect(gl.pixels(texture)).toEqual(next)
		expect(gl.getError()).toBe(GL.INVALID_OPERATION)
	})

	it('keeps pixels correct after a string bind target changes the real binding through GLenum coercion', () => {
		const { gl, call, upload } = harness()
		upload(frame())
		const second = call('createTexture')
		call('bindTexture', GL.TEXTURE_2D, second)
		upload(frame())
		call('bindTexture', String(GL.TEXTURE_2D), second)
		upload(frame(4, 8, 3))
		call('bindTexture', GL.TEXTURE_2D, second)
		const next = frame(4, 8, 0)
		upload(next)
		expect(gl.pixels(second)).toEqual(next)
	})

	it('uses the original full-image flip after a coerced unpack pname changes actual GL state', () => {
		const { gl, texture, call, upload } = harness()
		upload(frame())
		call('pixelStorei', String(GL.UNPACK_FLIP_Y_WEBGL), 1)
		const next = frame(4, 8, 2)
		upload(next)
		const original = harness({ register: false })
		original.call('pixelStorei', GL.UNPACK_FLIP_Y_WEBGL, true)
		original.upload(next)
		expect(gl.texImage2D).toHaveBeenCalledTimes(2)
		expect(gl.texSubImage2D).not.toHaveBeenCalled()
		expect(gl.pixels(texture)).toEqual(original.gl.pixels(original.texture))
	})

	it.each(['1', 1.5, 0x100000000])('uses the real full upload for a noncanonical unpack flag %s', param => {
		const { gl, texture, call, upload } = harness()
		upload(frame())
		call('pixelStorei', GL.UNPACK_FLIP_Y_WEBGL, param)
		const next = frame(4, 8, 2)
		upload(next)
		const original = harness({ register: false })
		original.call('pixelStorei', GL.UNPACK_FLIP_Y_WEBGL, param)
		original.upload(next)
		expect(gl.texImage2D).toHaveBeenCalledTimes(2)
		expect(gl.texSubImage2D).not.toHaveBeenCalled()
		expect(gl.pixels(texture)).toEqual(original.gl.pixels(original.texture))
	})

	it('confirms a changed-size allocation in full before uploading a band of the new dimensions', () => {
		const { gl, texture, upload } = harness()
		upload(frame())
		upload(frame(3, 10, 2), 3, 10)
		const next = frame(3, 10, 3)
		upload(next, 3, 10)
		expect(gl.texImage2D).toHaveBeenCalledTimes(2)
		expect(gl.texSubImage2D.mock.calls[0].slice(0, 8)).toEqual([GL.TEXTURE_2D, 0, 0, 0, 3, 3, GL.RGBA, GL.UNSIGNED_BYTE])
		expect(gl.getError).toHaveBeenCalledTimes(2)
		expect(gl.pixels(texture)).toEqual(next)
	})

	it('handles a large PAG-sized image without retaining a pixel snapshot or polling each update', () => {
		const { helper, gl, texture, upload } = harness()
		const width = 1440, height = 1080
		upload(frame(width, height, 1), width, height)
		const next = frame(width, height, 352)
		upload(next, width, height)
		expect(gl.texSubImage2D.mock.calls[0][8].byteLength).toBe(width * 352 * 4)
		expect(gl.pixels(texture).every((value, index) => value === next[index])).toBe(true)
		expect(helper.cachedBytes).toBe(0)
		expect(helper.entryCount).toBe(1)
		expect(gl.getError).toHaveBeenCalledTimes(1)
	})
})

describe('CanvasTextureUpload errors and lifetime', () => {
	it.each([undefined, 'webgl2', 'unknown'])('uses original calls without a registered WebGL1 context (%s)', actualType => {
		const { helper, gl, upload } = harness({ actualType, register: actualType !== undefined })
		upload(frame())
		upload(frame(4, 8, 2))
		expect(gl.texImage2D).toHaveBeenCalledTimes(2)
		expect(gl.texSubImage2D).not.toHaveBeenCalled()
		expect(gl.getParameter).not.toHaveBeenCalled()
		expect(gl.getError).not.toHaveBeenCalled()
		expect(helper.entryCount).toBe(0)
	})

	it('preserves a real null resource and its real allocation error', () => {
		const helper = new CanvasTextureUpload()
		const gl = context()
		helper.register(gl, 'webgl')
		gl.failNextCreate()
		const result = helper.invoke(gl, 'createTexture', [], () => gl.createTexture())
		expect(result).toBeNull()
		expect(helper.entryCount).toBe(0)
		expect(helper.drainErrors(gl)).toEqual([])
		expect(gl.getError()).toBe(GL.OUT_OF_MEMORY)
	})

	it('keeps null-data allocation on the real path and seeds only a subsequent successful full upload', () => {
		const { helper, gl, texture, call, upload } = harness()
		call('texImage2D', ...fullArgs(null))
		expect(gl.texImage2D).toHaveBeenCalledTimes(1)
		expect(gl.getError).not.toHaveBeenCalled()
		expect(helper.drainErrors(gl)).toEqual([])
		upload(frame())
		expect(gl.texImage2D).toHaveBeenCalledTimes(2)
		expect(gl.getError).toHaveBeenCalledTimes(1)
		const next = frame(4, 8, 2)
		upload(next)
		expect(gl.texSubImage2D).toHaveBeenCalledTimes(1)
		expect(gl.pixels(texture)).toEqual(next)
	})

	it('drains first-allocation errors into an ordered distinct stash and never replays the failed upload', () => {
		const { helper, gl, upload } = harness()
		gl.failNextImage(GL.INVALID_OPERATION, GL.OUT_OF_MEMORY, GL.INVALID_OPERATION)
		upload(frame())
		expect(gl.texImage2D).toHaveBeenCalledTimes(1)
		expect(gl.texSubImage2D).not.toHaveBeenCalled()
		expect(helper.drainErrors(gl)).toEqual([GL.INVALID_OPERATION, GL.OUT_OF_MEMORY])
		expect(helper.drainErrors(gl)).toEqual([])
		const errorReads = gl.getError.mock.calls.length
		upload(frame(4, 8, 2))
		expect(gl.getError).toHaveBeenCalledTimes(errorReads)
		expect(gl.texImage2D).toHaveBeenCalledTimes(2)
	})

	it('merges real errors with pending sampled flags before returning each distinct error once', () => {
		const { helper, gl, call, upload } = harness()
		gl.failNextImage(GL.INVALID_OPERATION, GL.OUT_OF_MEMORY)
		upload(frame())
		gl.raise(GL.INVALID_OPERATION, GL.INVALID_VALUE)
		expect(call('getError')).toBe(GL.INVALID_OPERATION)
		expect(helper.drainErrors(gl)).toEqual([GL.OUT_OF_MEMORY, GL.INVALID_VALUE])
		expect(call('getError')).toBe(GL.NO_ERROR)
	})

	it('preserves context loss and starts with new ownership and GL defaults after restoration', () => {
		const { helper, gl, call, upload } = harness()
		upload(frame())
		call('activeTexture', GL.TEXTURE0 + 1)
		call('pixelStorei', GL.UNPACK_FLIP_Y_WEBGL, true)
		call('pixelStorei', GL.UNPACK_ALIGNMENT, 8)
		call('pixelStorei', GL.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
		gl.lose()
		upload(frame(4, 8, 2))
		expect(gl.getError()).toBe(GL.CONTEXT_LOST_WEBGL)
		gl.recover()
		helper.restore(gl)
		const texture = call('createTexture')
		call('bindTexture', GL.TEXTURE_2D, texture)
		upload(frame(3, 8, 1), 3)
		call('activeTexture', GL.TEXTURE0)
		const next = frame(3, 8, 2)
		upload(next, 3)
		expect(gl.pixels(texture)).toEqual(next)
		expect(gl.texSubImage2D).toHaveBeenCalledTimes(1)
		expect(helper.entryCount).toBe(1)
	})

	it('preserves first-allocation context loss and disables the proof without replaying the upload', () => {
		const { helper, gl, upload } = harness()
		gl.lose()
		upload(frame())
		expect(helper.drainErrors(gl)).toEqual([GL.CONTEXT_LOST_WEBGL])
		const errorReads = gl.getError.mock.calls.length
		upload(frame(4, 8, 2))
		expect(gl.getError).toHaveBeenCalledTimes(errorReads)
		expect(gl.texImage2D).toHaveBeenCalledTimes(2)
		expect(gl.texSubImage2D).not.toHaveBeenCalled()
		expect(gl.getError()).toBe(GL.CONTEXT_LOST_WEBGL)
	})

	it('fails closed when allocation confirmation cannot read the driver error state', () => {
		const { gl, upload } = harness()
		gl.getError.mockImplementationOnce(() => { throw new Error('driver unavailable') })
		expect(() => upload(frame())).not.toThrow()
		upload(frame(4, 8, 2))
		expect(gl.texImage2D).toHaveBeenCalledTimes(2)
		expect(gl.texSubImage2D).not.toHaveBeenCalled()
	})

	it.each([
		['null allocation', null],
		['short byte view', new Uint8Array(127)],
		['full-sized non-byte view', new Uint16Array(64)],
	])('preserves original return values and validation errors for a %s', (name, pixels) => {
		const { helper, gl, upload } = harness()
		upload(frame())
		const result = { originalResult: name }
		const original = vi.fn(() => { gl.raise(GL.INVALID_OPERATION); return result })
		expect(helper.invoke(gl, 'texImage2D', fullArgs(pixels), original)).toBe(result)
		expect(original).toHaveBeenCalledTimes(1)
		expect(original).toHaveBeenCalledWith()
		expect(helper.drainErrors(gl)).toEqual([])
		expect(gl.getError()).toBe(GL.INVALID_OPERATION)
		upload(frame(4, 8, 2))
		expect(gl.texImage2D).toHaveBeenCalledTimes(2)
		expect(gl.texSubImage2D).not.toHaveBeenCalled()
	})

	it('propagates the original upload exception and never uses its prior proof afterward', () => {
		const { helper, gl, texture, upload } = harness()
		const initial = frame()
		upload(initial)
		const failure = new TypeError('original WebGL overload validation')
		expect(() => helper.invoke(gl, 'texImage2D', fullArgs(initial, 4.5), () => { throw failure })).toThrow(failure)
		expect(gl.pixels(texture)).toEqual(initial)
		const next = frame(4, 8, 2)
		upload(next)
		expect(gl.texSubImage2D).not.toHaveBeenCalled()
		expect(gl.pixels(texture)).toEqual(next)
	})

	it.each(['generateMipmap', 'copyTexImage2D', 'copyTexSubImage2D', 'compressedTexImage2D', 'compressedTexSubImage2D', 'texStorage2D'])('falls back after external texture mutation %s', method => {
		const { gl, call, upload } = harness()
		upload(frame())
		call(method, GL.TEXTURE_2D)
		upload(frame(4, 8, 2))
		expect(gl.texImage2D).toHaveBeenCalledTimes(2)
		expect(gl.texSubImage2D).not.toHaveBeenCalled()
	})

	it('falls back after an external subimage changes the supposedly constant tail', () => {
		const { gl, texture, call, upload } = harness()
		upload(frame())
		call('texSubImage2D', GL.TEXTURE_2D, 0, 0, 6, 4, 1, GL.RGBA, GL.UNSIGNED_BYTE, frame(4, 1, 1))
		const next = frame(4, 8, 2)
		upload(next)
		expect(gl.texImage2D).toHaveBeenCalledTimes(2)
		expect(gl.pixels(texture)).toEqual(next)
	})

	it('invalidates an attached texture even when another texture is bound', () => {
		const { gl, texture: attached, call, upload } = harness()
		upload(frame())
		const bound = call('createTexture')
		call('bindTexture', GL.TEXTURE_2D, bound)
		upload(frame())
		call('framebufferTexture2D', GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, attached, 0)
		upload(frame(4, 8, 2))
		expect(gl.texSubImage2D).toHaveBeenCalledTimes(1)
		call('bindTexture', GL.TEXTURE_2D, attached)
		upload(frame(4, 8, 2))
		expect(gl.texImage2D).toHaveBeenCalledTimes(3)
	})

	it('invalidates a proof after a valid DOM-source upload changes the whole image', () => {
		const { gl, texture, call, upload } = harness()
		upload(frame())
		call('texImage2D', GL.TEXTURE_2D, 0, GL.RGBA, GL.RGBA, GL.UNSIGNED_BYTE,
			{ width: 4, height: 8, data: frame(4, 8, 0, undefined, [30, 50, 70, 255]) })
		const next = frame(4, 8, 1)
		upload(next)
		expect(gl.texImage2D).toHaveBeenCalledTimes(3)
		expect(gl.texSubImage2D).not.toHaveBeenCalled()
		expect(gl.pixels(texture)).toEqual(next)
	})

	it('bounds aggregate texture metadata and releases quota after deletion and invalidation', () => {
		const { helper, gl, texture, call, upload } = harness({ maxEntries: 1 })
		upload(frame())
		const untracked = call('createTexture')
		call('bindTexture', GL.TEXTURE_2D, untracked)
		upload(frame())
		upload(frame(4, 8, 2))
		expect(helper.entryCount).toBe(1)
		expect(gl.texSubImage2D).not.toHaveBeenCalled()
		call('deleteTexture', texture)
		expect(helper.entryCount).toBe(0)
		const replacement = call('createTexture')
		call('bindTexture', GL.TEXTURE_2D, replacement)
		upload(frame())
		upload(frame(4, 8, 2))
		expect(gl.texSubImage2D).toHaveBeenCalledTimes(1)
		helper.invalidate(gl)
		helper.invalidate(gl)
		expect(helper.entryCount).toBe(0)
		expect(helper.cachedBytes).toBe(0)
	})

	it('keeps repeated registration idempotent without resetting a valid proof', () => {
		const { helper, gl, upload } = harness()
		upload(frame())
		helper.register(gl, 'webgl')
		upload(frame(4, 8, 2))
		expect(gl.texSubImage2D).toHaveBeenCalledTimes(1)
		expect(gl.getParameter.mock.calls).toEqual([[GL.MAX_COMBINED_TEXTURE_IMAGE_UNITS]])
	})

	it('forgets pre-resize ownership while preserving the actual active texture unit', () => {
		const { helper, gl, call, upload } = harness()
		upload(frame())
		call('activeTexture', GL.TEXTURE0 + 1)
		helper.reset(gl)
		expect(helper.entryCount).toBe(0)
		const texture = call('createTexture')
		call('bindTexture', GL.TEXTURE_2D, texture)
		upload(frame())
		call('activeTexture', GL.TEXTURE0)
		upload(frame(4, 8, 2))
		call('activeTexture', GL.TEXTURE0 + 1)
		const next = frame(4, 8, 3)
		upload(next)
		expect(gl.texSubImage2D).toHaveBeenCalledTimes(1)
		expect(gl.pixels(texture)).toEqual(next)
		expect(helper.entryCount).toBe(1)
	})

	it('preserves nondefault unpack alignment and flip state across a canvas resize', () => {
		for (const [pname, param, width] of [[GL.UNPACK_ALIGNMENT, 8, 3], [GL.UNPACK_FLIP_Y_WEBGL, true, 4]]) {
			const { helper, gl, call, upload } = harness()
			call('pixelStorei', pname, param)
			helper.reset(gl)
			const texture = call('createTexture')
			call('bindTexture', GL.TEXTURE_2D, texture)
			upload(frame(width, 8, 1), width)
			upload(frame(width, 8, 2), width)
			expect(gl.texImage2D).toHaveBeenCalledTimes(2)
			expect(gl.texSubImage2D).not.toHaveBeenCalled()
		}
	})

	it('enforces a single metadata quota across contexts and frees it when an owner is invalidated', () => {
		const { helper, gl: owner, upload } = harness({ maxEntries: 1 })
		upload(frame())
		const other = context()
		helper.register(other, 'experimental-webgl')
		const call = (method, ...args) => helper.invoke(other, method, args, () => other[method](...args))
		call('bindTexture', GL.TEXTURE_2D, call('createTexture'))
		call('texImage2D', ...fullArgs(frame()))
		call('texImage2D', ...fullArgs(frame(4, 8, 2)))
		expect(other.texSubImage2D).not.toHaveBeenCalled()
		expect(helper.entryCount).toBe(1)
		helper.invalidate(owner)
		const texture = call('createTexture')
		call('bindTexture', GL.TEXTURE_2D, texture)
		call('texImage2D', ...fullArgs(frame()))
		const next = frame(4, 8, 2)
		call('texImage2D', ...fullArgs(next))
		expect(other.texSubImage2D).toHaveBeenCalledTimes(1)
		expect(other.pixels(texture)).toEqual(next)
		helper.invalidate(other)
		expect(helper.entryCount).toBe(0)
	})

	it('keeps a zero-entry budget on the original path', () => {
		const { helper, gl, upload } = harness({ maxEntries: 0 })
		upload(frame())
		upload(frame(4, 8, 2))
		expect(helper.entryCount).toBe(0)
		expect(helper.cachedBytes).toBe(0)
		expect(gl.texImage2D).toHaveBeenCalledTimes(2)
		expect(gl.texSubImage2D).not.toHaveBeenCalled()
		expect(gl.getError).not.toHaveBeenCalled()
	})

	it('uses only TEXTURE0 when the real combined-unit limit is unavailable', () => {
		const helper = new CanvasTextureUpload()
		const gl = context()
		gl.getParameter.mockImplementation(() => undefined)
		helper.register(gl, 'webgl')
		const call = (method, ...args) => helper.invoke(gl, method, args, () => gl[method](...args))
		call('bindTexture', GL.TEXTURE_2D, call('createTexture'))
		call('texImage2D', ...fullArgs(frame()))
		call('texImage2D', ...fullArgs(frame(4, 8, 2)))
		expect(gl.texSubImage2D).toHaveBeenCalledTimes(1)
		call('activeTexture', GL.TEXTURE0 + 1)
		call('bindTexture', GL.TEXTURE_2D, call('createTexture'))
		call('texImage2D', ...fullArgs(frame()))
		call('texImage2D', ...fullArgs(frame(4, 8, 2)))
		expect(gl.texSubImage2D).toHaveBeenCalledTimes(1)
		expect(gl.getParameter.mock.calls).toEqual([[GL.MAX_COMBINED_TEXTURE_IMAGE_UNITS]])
	})

	it('disables the entire context generation for unknown extension mutations', () => {
		const { helper, gl, call, upload } = harness()
		upload(frame())
		helper.disable(gl)
		helper.register(gl, 'webgl')
		const next = call('createTexture')
		call('bindTexture', GL.TEXTURE_2D, next)
		upload(frame())
		upload(frame(4, 8, 2))
		expect(gl.texSubImage2D).not.toHaveBeenCalled()
		expect(helper.entryCount).toBe(0)
	})
})

describe('opaque premultiplication upload proof', () => {
	it('temporarily skips premultiplication only after verifying every RGBA alpha byte', () => {
		const width = 256, height = 512, f = harness()
		f.call('pixelStorei', GL.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
		f.upload(frame(width, height, 200), width, height)
		f.gl.pixelStorei.mockClear()
		f.helper.prepareRleUpload(f.gl, fullArgs(rleWire(width, height, 240), width, height))()
		expect(f.gl.pixelStorei.mock.calls).toEqual([[GL.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false], [GL.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true]])
		expect(Buffer.from(f.gl.pixels(f.texture)).equals(Buffer.from(frame(width, height, 240, [9, 80, 211, 255])))).toBe(true)
	})
	it('preserves premultiplication when any active pixel is translucent', () => {
		const width = 256, height = 512, f = harness()
		f.call('pixelStorei', GL.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
		f.upload(frame(width, height, 200), width, height)
		f.gl.pixelStorei.mockClear()
		f.helper.prepareRleUpload(f.gl, fullArgs(rleWire(width, height, 240, [9, 80, 211, 127]), width, height))()
		expect(f.gl.pixelStorei).not.toHaveBeenCalled()
	})
	it('restores premultiplication when the actual upload throws', () => {
		const width = 256, height = 512, f = harness()
		f.call('pixelStorei', GL.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
		f.upload(frame(width, height, 200), width, height)
		f.gl.pixelStorei.mockClear()
		const upload = f.helper.prepareRleUpload(f.gl, fullArgs(rleWire(width, height, 240), width, height))
		f.gl.texSubImage2D.mockImplementationOnce(() => { throw new Error('driver upload failed') })
		expect(upload).toThrow('driver upload failed')
		expect(f.gl.pixelStorei.mock.calls.at(-1)).toEqual([GL.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true])
	})
})


describe('synchronous borrowed band upload', () => {
	it('uploads every current pixel before clearing its temporary view, including shrinking rows', () => {
		const width = 256, height = 512, f = harness()
		f.call('pixelStorei', GL.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
		f.upload(frame(width, height, 200), width, height)
		for (const rows of [240, 210, 250, 180]) {
			expect(f.helper.invokeRleUpload(f.gl, fullArgs(rleWire(width, height, rows), width, height))).toBe(true)
			expect(Buffer.from(f.gl.pixels(f.texture)).equals(Buffer.from(frame(width, height, rows, [9, 80, 211, 255])))).toBe(true)
			expect(f.gl.texSubImage2D.mock.calls.at(-1)[8].some(byte => byte !== 0)).toBe(false)
		}
		expect(f.gl.texImage2D).toHaveBeenCalledTimes(1)
		expect(f.gl.texSubImage2D).toHaveBeenCalledTimes(4)
		expect(f.helper.cachedBytes).toBe(0)
	})
	it('clears scratch and restores unpack state after an upload exception, then recovers', () => {
		const width = 256, height = 512, f = harness()
		f.call('pixelStorei', GL.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
		f.upload(frame(width, height, 200), width, height)
		let borrowed
		f.gl.texSubImage2D.mockImplementationOnce((...args) => { borrowed = args[8]; throw new Error('upload failed') })
		const args = fullArgs(rleWire(width, height, 240), width, height)
		expect(() => f.helper.invokeRleUpload(f.gl, args)).toThrow('upload failed')
		expect(borrowed.some(byte => byte !== 0)).toBe(false)
		expect(f.gl.pixelStorei.mock.calls.at(-1)).toEqual([GL.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true])
		expect(f.helper.invokeRleUpload(f.gl, args)).toBe(true)
		expect(Buffer.from(f.gl.pixels(f.texture)).equals(Buffer.from(frame(width, height, 240, [9, 80, 211, 255])))).toBe(true)
	})
	it('validates even an omitted malformed tail before invoking the real GL method', () => {
		const width = 256, height = 512, f = harness()
		f.upload(frame(width, height, 200), width, height)
		const wire = rleWire(width, height, 240), encoded = Buffer.from(wire.base64, 'base64')
		encoded.writeUInt32LE(0x80000000 + width * height, encoded.length - 8)
		wire.base64 = encoded.toString('base64')
		expect(f.helper.invokeRleUpload(f.gl, fullArgs(wire, width, height))).toBe(false)
		expect(f.gl.texSubImage2D).not.toHaveBeenCalled()
	})
})
