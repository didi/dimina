import { DataStream, createFile } from 'mp4box'
import { getFileSystemManager } from '@/api/core/file'
import message from '@/core/message'
import router from '@/core/router'

const sessions = new Set()
const instances = new Set()
const MAX_SOURCE_BYTES = 128 * 1024 * 1024
const MAX_FRAME_PIXELS = 2097152

export function supportsWebVideoDecoder() {
	return typeof globalThis.VideoDecoder === 'function' && typeof globalThis.VideoDecoder.isConfigSupported === 'function' && typeof globalThis.EncodedVideoChunk === 'function'
		&& typeof globalThis.OffscreenCanvas === 'function'
}

function frameBudget(width, height) {
	if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0
		|| width > 4096 || height > 4096 || width * height > MAX_FRAME_PIXELS) throw new RangeError('video frame exceeds pixel budget')
}

export function demuxMP4(buffer) {
	if (!(buffer instanceof ArrayBuffer) || buffer.byteLength > MAX_SOURCE_BYTES) throw new RangeError('video source exceeds 128 MiB')
	const file = createFile()
	let result
	let failure
	file.onError = error => { failure = new Error(`invalid MP4: ${error}`) }
	file.onReady = info => {
		const track = info.videoTracks[0]
		if (!track) throw new Error('MP4 has no video track')
		frameBudget(track.video.width, track.video.height)
		const trak = file.getTrackById(track.id)
		const edits = trak.edts?.elst?.entries || []
		const mediaEdit = edits.find(edit => edit.media_time >= 0)
		if ((edits.length && !mediaEdit) || edits.filter(edit => edit.media_time >= 0).length > 1 || edits.some(edit => edit.media_rate_integer !== 1 || edit.media_rate_fraction !== 0)) throw new Error('MP4 edit list is not supported')
		const emptyDuration = edits.slice(0, edits.indexOf(mediaEdit)).reduce((sum, edit) => sum + edit.segment_duration / file.moov.mvhd.timescale, 0)
		const timestampOffset = Math.round(((mediaEdit?.media_time || 0) / track.timescale - emptyDuration) * 1000000)
		const entry = trak.mdia.minf.stbl.stsd.entries[0]
		const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C
		let description
		if (box) {
			const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN)
			box.write(stream)
			description = new Uint8Array(stream.buffer, 8)
		}
		result = {
			config: { codec: track.codec, codedWidth: track.video.width, codedHeight: track.video.height, description },
			samples: [], width: track.video.width, height: track.video.height,
		}
		file.onSamples = (_id, _user, samples) => {
			result.samples.push(...samples.map(sample => ({
				key: sample.is_sync, data: sample.data,
				timestamp: Math.round(sample.cts * 1000000 / sample.timescale) - timestampOffset,
				duration: Math.round(sample.duration * 1000000 / sample.timescale),
			})))
			file.releaseUsedSamples(track.id, samples.at(-1).number + 1)
		}
		file.setExtractionOptions(track.id, null, { nbSamples: 256 })
		file.start()
	}
	buffer.fileStart = 0
	try { file.appendBuffer(buffer); file.flush() }
	finally { file.stop() }
	if (failure) throw failure
	if (!result?.samples.length) throw new Error('MP4 has no video samples')
	if (!result.samples[0].key) throw new Error('MP4 first video sample is not a key frame')
	return result
}

async function readSource(source, signal) {
	if (/^(https?:|blob:|data:)/.test(source)) {
		const response = await fetch(source, { signal })
		if (!response.ok) throw new Error(`video source HTTP ${response.status}`)
		if (Number(response.headers.get('content-length')) > MAX_SOURCE_BYTES) throw new RangeError('video source exceeds 128 MiB')
		const reader = response.body.getReader()
		const chunks = []
		let length = 0
		try {
			while (true) {
				const { done, value } = await reader.read()
				if (done) break
				length += value.byteLength
				if (length > MAX_SOURCE_BYTES) throw new RangeError('video source exceeds 128 MiB')
				chunks.push(value)
			}
		} finally { await reader.cancel().catch(() => {}) }
		const bytes = new Uint8Array(length)
		let offset = 0
		for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
		return bytes.buffer
	}
	return new Promise((resolve, reject) => {
		const abort = () => reject(new Error('VideoDecoder control was stopped'))
		signal.addEventListener('abort', abort, { once: true })
		if (signal.aborted) { abort(); return }
		getFileSystemManager().readFile({ filePath: source,
			success: result => { signal.removeEventListener('abort', abort); resolve(result.data) },
			fail: error => { signal.removeEventListener('abort', abort); reject(new Error(error.errMsg || 'video source read failed')) },
		})
	})
}

export class WebVideoDecoder {
	constructor() {
		this.bridgeId = router.getPageInfo()?.bridgeId || router.getPageInfo()?.id || ''
		this.listeners = new Map()
		this.frames = []
		this.generation = 0
		this.tail = Promise.resolve()
		this.width = 0
		this.height = 0
		this.pendingControls = 0
		this.outputs = new Set()
		instances.add(this)
	}
	on(event, listener) { if (!this.removed && typeof listener === 'function') { if (!this.listeners.has(event)) this.listeners.set(event, new Set()); this.listeners.get(event).add(listener) } }
	off(event, listener) { if (listener === undefined) this.listeners.delete(event); else this.listeners.get(event)?.delete(listener) }
	emit(event, data) { for (const listener of [...(this.listeners.get(event) || [])]) listener(data) }
	check(generation) {
		if (this.removed) throw new Error('VideoDecoder has been removed')
		if (generation !== this.generation) throw new Error('VideoDecoder control was stopped')
	}
	control(operation) {
		const generation = this.generation
		this.pendingControls++
		const result = this.tail.then(() => { this.check(generation); return operation(generation) }).finally(() => { if (generation === this.generation) this.pendingControls-- })
		this.tail = result.catch(() => {})
		return result
	}
	start(options = {}) {
		if (typeof options.source !== 'string' || !options.source) return Promise.reject(new TypeError('VideoDecoder.start: source is required'))
		if (![0, 1].includes(options.mode ?? 1)) return Promise.reject(new TypeError('VideoDecoder.start: mode must be 0 or 1'))
		return this.control(async generation => {
			if (!supportsWebVideoDecoder()) throw new Error('WebCodecs video decoding is not supported in this browser')
			if (!sessions.has(this) && sessions.size >= 4) throw new Error('VideoDecoder exceeds the 4 decoder limit')
			sessions.add(this)
			this.clear()
			this.abort = new AbortController()
			try {
				const bytes = await readSource(options.source, this.abort.signal)
				this.check(generation)
				const media = demuxMP4(bytes)
				const support = await globalThis.VideoDecoder.isConfigSupported(media.config)
				this.check(generation)
				if (!support.supported) throw new Error(`video codec ${media.config.codec} is not supported in this browser`)
				this.media = media
				this.width = media.width
				this.height = media.height
				this.mode = options.mode ?? 1
				this.configure(0)
				const result = { width: this.width, height: this.height }
				this.emit('start', result)
				return result
			} catch (error) { if (generation === this.generation) this.clear(); throw error }
		})
	}
	configure(position) {
		this.clear(false)
		const generation = this.decodeGeneration
		this.targetUs = Math.round(position * 1000)
		this.index = 0
		for (let index = 0; index < this.media.samples.length; index++) {
			if (this.media.samples[index].key && this.media.samples[index].timestamp <= this.targetUs) this.index = index
		}
		this.running = true
		this.copies = 0
		this.copyTail = Promise.resolve()
		this.decoder = new globalThis.VideoDecoder({
			output: frame => this.output(frame, generation),
			error: error => { if (generation === this.decodeGeneration) this.fail(error) },
		})
		this.decoder.configure(this.media.config)
		this.decoder.addEventListener('dequeue', () => { if (generation === this.decodeGeneration) this.pump() })
		this.pump()
	}
	output(frame, generation) {
		if (generation !== this.decodeGeneration || !this.running || frame.timestamp < this.targetUs) { frame.close(); return }
		// At most eight browser outputs (including in-flight RGBA copies). Decoder
		// input is fed two chunks at a time and pauses once two outputs are ready.
		if (this.frames.length + this.copies >= 8) { frame.close(); this.fail(new Error('video output exceeds frame queue budget')); return }
		this.copies++
		this.outputs.add(frame)
		// WebCodecs emits presentation order; serialize asynchronous RGBA copies
		// to preserve that order even when one frame takes longer to copy.
		this.copyTail = this.copyTail.then(async () => {
			try {
				if (generation !== this.decodeGeneration || !this.running) return
				const width = frame.displayWidth
				const height = frame.displayHeight
				frameBudget(width, height)
				let data
				try {
					data = new Uint8Array(width * height * 4)
					await frame.copyTo(data, { format: 'RGBA', rect: frame.visibleRect })
				} catch {
					if (generation !== this.decodeGeneration || !this.running) return
					this.copyCanvas ||= new globalThis.OffscreenCanvas(width, height)
					this.copyCanvas.width = width
					this.copyCanvas.height = height
					const context = this.copyCanvas.getContext('2d', { willReadFrequently: true })
					context.drawImage(frame, 0, 0, width, height)
					data = context.getImageData(0, 0, width, height).data
				}
				if (generation === this.decodeGeneration && this.running) this.frames.push({ width, height, data: data.buffer, pts: frame.timestamp, pkPts: frame.timestamp })
			} catch (error) { if (generation === this.decodeGeneration) this.fail(error) }
			finally { if (this.outputs.delete(frame)) frame.close(); if (generation === this.decodeGeneration) { this.copies--; this.pump() } }
		})
	}
	pump() {
		if (!this.running || this.error || this.flushing) return
		const generation = this.decodeGeneration
		try {
			while (this.index < this.media.samples.length && this.decoder.decodeQueueSize < 2 && this.frames.length + this.copies < 2) {
				const sample = this.media.samples[this.index++]
				this.decoder.decode(new globalThis.EncodedVideoChunk({ type: sample.key ? 'key' : 'delta', timestamp: sample.timestamp, duration: sample.duration, data: sample.data }))
			}
			if (this.index === this.media.samples.length) {
				this.flushing = true
				this.decoder.flush().then(() => { if (generation === this.decodeGeneration) this.inputEnded = true }, error => { if (generation === this.decodeGeneration) this.fail(error) })
			}
		} catch (error) { this.fail(error) }
	}
	fail(error) { this.closeOutputs(); this.error = error; this.running = false; this.frames = []; if (this.decoder?.state !== 'closed') this.decoder?.close() }
	getFrameData() {
		if (this.removed) return null
		if (this.error) throw this.error
		if (!this.running || this.pendingControls) return null
		const frame = this.frames[0]
		if (frame) {
			if (this.clock === undefined) { this.clock = performance.now(); this.clockPts = frame.pts }
			if (this.mode === 0 && frame.pts - this.clockPts > (performance.now() - this.clock) * 1000) return null
			this.frames.shift()
			this.pump()
			return frame
		}
		if (this.inputEnded && this.copies === 0 && !this.ended) { this.ended = true; this.emit('ended', {}) }
		return null
	}
	seek(position) {
		if (typeof position !== 'number' || !Number.isFinite(position) || position < 0 || position * 1000 > Number.MAX_SAFE_INTEGER) return Promise.reject(new TypeError('VideoDecoder.seek: invalid position in milliseconds'))
		return this.control(() => {
			if (!this.media || !this.running) throw new Error('VideoDecoder is not running')
			this.configure(position)
			this.emit('seek', { position })
			return position
		})
	}
	closeOutputs() { for (const frame of this.outputs) frame.close(); this.outputs.clear() }
	clear(releaseSource = true) {
		this.closeOutputs()
		this.decodeGeneration = (this.decodeGeneration || 0) + 1
		if (this.decoder?.state !== 'closed') this.decoder?.close()
		this.decoder = null
		this.abort?.abort()
		this.abort = null
		this.running = false
		this.frames = []
		this.flushing = false
		this.inputEnded = false
		this.ended = false
		this.error = null
		this.clock = undefined
		if (this.copyCanvas) { this.copyCanvas.width = 0; this.copyCanvas.height = 0 }
		this.copyCanvas = null
		if (releaseSource) this.media = null
	}
	stop() { if (this.removed) return Promise.reject(new Error('VideoDecoder has been removed')); this.generation++; this.pendingControls = 0; this.clear(); this.tail = Promise.resolve(); this.emit('stop', {}); return Promise.resolve() }
	remove() { if (!this.removed) { this.removed = true; this.generation++; this.pendingControls = 0; this.clear(); this.listeners.clear(); sessions.delete(this); instances.delete(this) } return Promise.resolve() }
}

message.on('pageUnload', ({ bridgeId }) => { for (const decoder of [...instances]) if (decoder.bridgeId === bridgeId) decoder.remove() })
