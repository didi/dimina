import { base64ToArrayBuffer, decodeCanvasRle32PrefixWithTail, decodeLargeCanvasRleBand } from '@dimina/common'

const TEXTURE_2D = 0x0DE1
const TEXTURE0 = 0x84C0
const RGBA = 0x1908
const UNSIGNED_BYTE = 0x1401
const UNPACK_ALIGNMENT = 0x0CF5
const UNPACK_FLIP_Y_WEBGL = 0x9240
const UNPACK_PREMULTIPLY_ALPHA_WEBGL = 0x9241
const UNPACK_COLORSPACE_CONVERSION_WEBGL = 0x9243
const BROWSER_DEFAULT_WEBGL = 0x9244
const MAX_INPUT_BYTES = 32 * 1024 * 1024
const littleEndian = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1

// Retain only a constant-tail proof, never a prior frame's pixels. The active
// band grows before every attempted update, so a failed update cannot make a
// later upload omit any row that might have been written previously.
export class CanvasTextureUpload {
	constructor({ maxEntries = 1024 } = {}) {
		this.states = new WeakMap()
		this.maxEntries = Number.isSafeInteger(maxEntries) && maxEntries >= 0 ? maxEntries : 1024
		this.entryCount = 0
	}

	get cachedBytes() { return 0 }

	register(context, actualType) {
		if (!context || !['webgl', 'experimental-webgl'].includes(actualType)) {
			if (context) this.invalidate(context)
			return
		}
		if (this.states.has(context)) return
		let maxUnits = 1
		try {
			const actual = context.getParameter?.(0x8B4D) // MAX_COMBINED_TEXTURE_IMAGE_UNITS
			if (Number.isSafeInteger(actual) && actual > 0 && actual <= 4096) maxUnits = actual
		} catch { /* Only TEXTURE0 is safe without the real unit limit. */ }
		this.states.set(context, {
			actualType, maxUnits, disabled: false,
			textures: new Map(), bindings: new Map(), activeTexture: TEXTURE0,
			unpack: { alignment: 4, flip: false, premultiply: false, colorspace: BROWSER_DEFAULT_WEBGL },
			errors: [],
		})
	}

	// Resizing a WebGL canvas preserves its GL bindings and pixel-store state.
	// Forget texture proofs without inventing new default GL state.
	reset(context) {
		const state = this.states.get(context)
		if (!state) return
		this.entryCount -= state.textures.size
		state.textures.clear()
		state.bindings.clear()
	}

	restore(context) {
		const actualType = this.states.get(context)?.actualType
		this.invalidate(context)
		if (actualType) this.register(context, actualType)
	}

	disable(context) {
		const state = this.states.get(context)
		if (!state) return
		this.reset(context)
		state.disabled = true
	}

	invalidate(context) {
		const state = this.states.get(context)
		if (!state) return
		this.entryCount -= state.textures.size
		this.states.delete(context)
	}

	drainErrors(context) {
		const state = this.states.get(context)
		return state ? state.errors.splice(0) : []
	}

	invoke(context, method, args, invokeOriginal) {
		const state = this.states.get(context)
		if (!state) return invokeOriginal()
		if (method === 'getError' && state.errors.length) {
			// The driver may have raised a flag we stashed already. It represents
			// one pending WebGL error, not two errors merely because we sampled it.
			for (let i = 0; i < 32; i++) {
				const error = context.getError()
				if (error === 0) break
				if (!state.errors.includes(error)) state.errors.push(error)
			}
			return state.errors.shift()
		}
		if (state.disabled) return invokeOriginal()
		const bound = () => state.textures.get(state.bindings.get(state.activeTexture))
		const disable = entry => { if (entry) { entry.disabled = true; entry.tail = null } }
		const disableAll = () => { for (const entry of state.textures.values()) disable(entry) }

		if (method === 'texImage2D') return this.upload(context, state, bound(), args, invokeOriginal)
		if (['texSubImage2D', 'copyTexImage2D', 'copyTexSubImage2D', 'compressedTexImage2D',
			'compressedTexSubImage2D', 'generateMipmap', 'texStorage2D'].includes(method)) disable(bound())
		if (method === 'framebufferTexture2D') disable(state.textures.get(args[3]))
		if (method === 'framebufferTextureLayer') disable(state.textures.get(args[2]))
		if (method === 'activeTexture' && !(Number.isInteger(args[0]) && args[0] >= TEXTURE0
			&& args[0] < TEXTURE0 + state.maxUnits)) disableAll()
		if (method === 'bindTexture' && !(Number.isInteger(args[0]) && args[0] >= 0 && args[0] <= 0xFFFFFFFF)) {
			disableAll()
			state.bindings.clear()
		}
		if (method === 'pixelStorei' && !(Number.isInteger(args[0]) && args[0] >= 0 && args[0] <= 0xFFFFFFFF)) {
			// WebIDL may coerce a non-canonical pname to an unpack setting. None of
			// the default shadows are trustworthy after an unknown setting call.
			disableAll()
			state.disabled = true
		}
		if (method === 'bindTexture' && args[0] === TEXTURE_2D && args[1] !== null) {
			const entry = state.textures.get(args[1])
			// An invalid/foreign bind can leave the previous texture bound in GL.
			// Never preserve its tail proof while shadow ownership is unknown.
			if (!entry || entry.disabled || entry.target && entry.target !== TEXTURE_2D) disable(bound())
		}

		const result = invokeOriginal()
		if (method === 'createTexture' && result && !state.textures.has(result) && this.entryCount < this.maxEntries) {
			state.textures.set(result, { disabled: false, target: null, tail: null })
			this.entryCount++
		}
		else if (method === 'deleteTexture') {
			if (state.textures.delete(args[0])) this.entryCount--
			for (const [unit, texture] of state.bindings) if (texture === args[0]) state.bindings.delete(unit)
		}
		else if (method === 'activeTexture') {
			// Invalid enum coercions leave GL's active unit unchanged. Forget the
			// shadow binding instead of guessing which texture received later calls.
			const unit = args[0]
			if (Number.isInteger(unit) && unit >= TEXTURE0 && unit < TEXTURE0 + state.maxUnits) state.activeTexture = unit
			else state.activeTexture = null
		}
		else if (method === 'bindTexture') {
			const entry = state.textures.get(args[1])
			if (entry && (!entry.target || entry.target === args[0])) entry.target = args[0]
			else if (entry) disable(entry)
			if (args[0] === TEXTURE_2D && state.activeTexture !== null) {
				state.bindings.set(state.activeTexture, entry?.target === TEXTURE_2D && !entry.disabled ? args[1] : null)
			}
			else if (entry) disable(entry)
		}
		else if (method === 'pixelStorei') {
			const [pname, param] = args
			if (pname === UNPACK_ALIGNMENT) state.unpack.alignment = [1, 2, 4, 8].includes(param) ? param : null
			else if (pname === UNPACK_FLIP_Y_WEBGL || pname === UNPACK_PREMULTIPLY_ALPHA_WEBGL) {
				const value = typeof param === 'boolean' || Number.isInteger(param) && param >= -0x80000000
					&& param <= 0x7FFFFFFF ? Boolean(param) : null
				state.unpack[pname === UNPACK_FLIP_Y_WEBGL ? 'flip' : 'premultiply'] = value
			}
			else if (pname === UNPACK_COLORSPACE_CONVERSION_WEBGL) state.unpack.colorspace = [0, BROWSER_DEFAULT_WEBGL].includes(param) ? param : null
		}
		return result
	}

	prepareRleUpload(context, args) {
		const state = this.states.get(context)
		const entry = state?.textures.get(state.bindings.get(state.activeTexture))
		const prior = entry?.tail, unpack = state?.unpack
		const [target, level, internalFormat, width, height, border, format, type, wire] = args
		const bytes = width * height * 4
		if (!state || state.disabled || !entry || entry.disabled || !prior || entry.target !== TEXTURE_2D
			|| args.length !== 9 || target !== TEXTURE_2D || level !== 0 || border !== 0
			|| internalFormat !== RGBA || format !== RGBA || type !== UNSIGNED_BYTE
			|| !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0
			|| !Number.isSafeInteger(bytes) || bytes > MAX_INPUT_BYTES
			|| !wire || !['Uint8Array', 'Uint8ClampedArray'].includes(wire.__canvasTypedArray)
			|| wire.encoding !== 'rle32-v1' || wire.byteLength !== bytes || typeof wire.base64 !== 'string'
			|| unpack.flip !== false || typeof unpack.premultiply !== 'boolean'
			|| ![1, 2, 4, 8].includes(unpack.alignment) || width * 4 % unpack.alignment !== 0
			|| ![0, BROWSER_DEFAULT_WEBGL].includes(unpack.colorspace)
			|| prior.width !== width || prior.height !== height || prior.alignment !== unpack.alignment
			|| prior.premultiply !== unpack.premultiply || prior.colorspace !== unpack.colorspace) return null
		const fast = decodeLargeCanvasRleBand(wire.base64, bytes, width, height, prior.rows, prior.word)
		if (fast) {
			const pixels = new Uint8Array(fast.buffer)
			return () => {
				prior.rows = fast.rows
				if (fast.rows > 0) return context.texSubImage2D(target, level, 0, 0, width, fast.rows, format, type, pixels)
			}
		}
		const encoded = base64ToArrayBuffer(wire.base64)
		if (encoded.byteLength < 8 || encoded.byteLength % 4 !== 0) return null
		const candidate = new DataView(encoded)
		const finalToken = candidate.getUint32(encoded.byteLength - 8, true)
		const tailWords = finalToken & 0x7FFFFFFF
		const tailWord = candidate.getUint32(encoded.byteLength - 4, true)
		if (!(finalToken & 0x80000000) || tailWords === 0 || tailWords > bytes / 4 || tailWord !== prior.word) return null
		const activeRows = Math.ceil((bytes / 4 - tailWords) / width)
		const rows = Math.max(prior.rows, activeRows)
		if (rows > height / 2) return null
		// Peeking only chooses a bounded output size. Validate the whole packet
		// and prove that those final eight bytes really are a run before drawing.
		const decoded = decodeCanvasRle32PrefixWithTail(encoded, bytes, rows * width * 4)
		if (decoded.tailWord !== tailWord || decoded.tailWords !== tailWords) return null
		const pixels = new Uint8Array(decoded.buffer)
		return () => {
			// Advance before the real upload, including failed driver attempts.
			prior.rows = rows
			if (rows > 0) return context.texSubImage2D(target, level, 0, 0, width, rows, format, type, pixels)
		}
	}

	upload(context, state, entry, args, invokeOriginal) {
		const [target, level, internalFormat, width, height, border, format, type, pixels] = args
		const unpack = state.unpack
		const bytes = width * height * 4
		const valid = entry && !entry.disabled && entry.target === TEXTURE_2D
			&& args.length === 9 && target === TEXTURE_2D && level === 0 && border === 0
			&& internalFormat === RGBA && format === RGBA && type === UNSIGNED_BYTE
			&& Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0
			&& Number.isSafeInteger(bytes) && bytes <= MAX_INPUT_BYTES
			&& (pixels instanceof Uint8Array || pixels instanceof Uint8ClampedArray)
			&& pixels.buffer instanceof ArrayBuffer && pixels.byteLength === bytes
			&& unpack.flip === false && typeof unpack.premultiply === 'boolean'
			&& [1, 2, 4, 8].includes(unpack.alignment) && width * 4 % unpack.alignment === 0
			&& [0, BROWSER_DEFAULT_WEBGL].includes(unpack.colorspace)
		if (!valid) {
			// A full redefinition (including null allocation or another source
			// kind) ends the old proof. A later successful full RGBA upload may
			// establish a new one; structural exclusions remain permanent.
			if (entry) entry.tail = null
			return invokeOriginal()
		}
		let prior = entry.tail
		if (prior && (prior.width !== width || prior.height !== height || prior.alignment !== unpack.alignment
			|| prior.premultiply !== unpack.premultiply || prior.colorspace !== unpack.colorspace)) {
			entry.tail = null
			prior = null
		}
		const words = littleEndian && pixels.byteOffset % 4 === 0
			? new Uint32Array(pixels.buffer, pixels.byteOffset, bytes / 4) : null
		const view = words ? null : new DataView(pixels.buffer, pixels.byteOffset, bytes)
		const tailWord = prior ? prior.word : words ? words[words.length - 1] : view.getUint32(bytes - 4, true)
		let last = bytes / 4 - 1
		if (words) { while (last >= 0 && words[last] === tailWord) last-- }
		else { while (last >= 0 && view.getUint32(last * 4, true) === tailWord) last-- }
		const activeRows = last < 0 ? 0 : Math.floor(last / width) + 1
		const rows = Math.max(prior?.rows || 0, activeRows)
		if (rows > height / 2) {
			entry.tail = null
			return invokeOriginal()
		}
		if (prior) {
			// Advance even if the driver subsequently rejects this update. A future
			// band must cover every row that may have been changed by any attempt.
			prior.rows = rows
			if (rows === 0) return undefined
			return context.texSubImage2D(target, level, 0, 0, width, rows, format, type, pixels.subarray(0, rows * width * 4))
		}
		const result = invokeOriginal()
		let failed = false
		try {
			for (let i = 0; i < 32; i++) {
				const error = context.getError()
				if (error === 0) break
				failed = true
				if (typeof error !== 'number') break
				if (!state.errors.includes(error)) state.errors.push(error)
			}
			failed ||= typeof context.isContextLost !== 'function' || context.isContextLost()
		} catch { failed = true }
		if (failed) entry.disabled = true
		else entry.tail = { word: tailWord, rows, width, height, alignment: unpack.alignment,
			premultiply: unpack.premultiply, colorspace: unpack.colorspace }
		return result
	}
}
