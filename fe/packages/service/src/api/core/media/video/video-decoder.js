import { uuid } from '@dimina/common'
import { invokeAPI } from '@/api/common'
import { base64ToArrayBuffer } from '@/api/core/network/socket/shared'

export function createVideoDecoder() {
	return new VideoDecoder()
}

// The native backends prefetch a bounded number of frames. getFrameData must
// remain synchronous. Controls are serialized; stop/removal can cancel a start.
class VideoDecoder {
	constructor() {
		this.videoDecoderId = `video_decoder_${uuid()}`
		this.width = 0
		this.height = 0
		this.listeners = new Map()
		this.removed = false
		this.running = false
		this.ended = false
		this.pendingControls = 0
		this.pendingStarts = 0
		this.generation = 0
		this.startDispatched = false
		this.tail = Promise.resolve()
	}

	start(options = {}) {
		if (typeof options.source !== 'string' || !options.source) {
			return Promise.reject(new TypeError('VideoDecoder.start: source is required'))
		}
		const mode = options.mode ?? 1
		if (mode !== 0 && mode !== 1) {
			return Promise.reject(new TypeError('VideoDecoder.start: mode must be 0 or 1'))
		}
		return this.control('start', { source: options.source, mode }, (result) => {
			this.width = result.width
			this.height = result.height
			this.running = true
			this.ended = false
			this.emit('start', result)
			return result
		})
	}

	seek(position) {
		if (typeof position !== 'number' || !Number.isFinite(position) || position < 0) {
			return Promise.reject(new TypeError('VideoDecoder.seek: position must be a non-negative number in milliseconds'))
		}
		return this.control('seek', { position }, () => {
			this.ended = false
			this.emit('seek', { position })
			return position
		})
	}

	stop() {
		const interrupt = this.pendingStarts > 0
		if (interrupt) {
			this.generation++
			this.pendingControls = 0
			this.pendingStarts = 0
		}
		// A remote start may be waiting for bytes. Stop must reach native now,
		// while a start still waiting in this JS queue can be cancelled locally.
		return this.control('stop', {}, () => {
			this.running = false
			this.emit('stop', {})
		}, { interrupt, skipNative: !this.startDispatched })
	}

	remove() {
		if (this.removed) return Promise.resolve()
		this.removed = true
		this.running = false
		this.listeners.clear()
		// Removal bypasses the control queue so an unfinished start cannot revive
		// this instance. Native teardown also invalidates pending work by owner/id.
		return Promise.resolve(invokeAPI('VideoDecoder.remove', { decoderId: this.videoDecoderId }))
	}

	getFrameData() {
		if (this.removed || !this.running || this.pendingControls) return null
		const result = invokeAPI('VideoDecoder.getFrameData', { decoderId: this.videoDecoderId }, 'container', false)
		if (result?.error) throw new Error(`VideoDecoder.getFrameData: ${result.error}`)
		if (result?.data) {
			const encoded = result.data.__diminaArrayBufferBase64
			return { ...result, data: encoded === undefined ? result.data : base64ToArrayBuffer(encoded) }
		}
		if (result?.ended && !this.ended) {
			this.ended = true
			this.emit('ended', {})
		}
		return null
	}

	on(eventName, listener) {
		if (this.removed || typeof listener !== 'function') return
		let listeners = this.listeners.get(eventName)
		if (!listeners) this.listeners.set(eventName, listeners = new Set())
		listeners.add(listener)
	}

	off(eventName, listener) {
		if (listener === undefined) this.listeners.delete(eventName)
		else this.listeners.get(eventName)?.delete(listener)
	}

	emit(eventName, data) {
		for (const listener of [...(this.listeners.get(eventName) || [])]) listener(data)
	}

	control(command, params, complete, { interrupt = false, skipNative = false } = {}) {
		if (this.removed) return Promise.reject(new Error('VideoDecoder has been removed'))
		const generation = this.generation
		this.pendingControls++
		if (command === 'start') this.pendingStarts++
		const operation = (interrupt ? Promise.resolve() : this.tail).then(async () => {
			if (this.removed) throw new Error('VideoDecoder has been removed')
			if (generation !== this.generation) throw new Error('VideoDecoder control was stopped')
			if (command === 'start') this.startDispatched = true
			const result = skipNative ? {} : await invokeAPI(`VideoDecoder.${command}`, { decoderId: this.videoDecoderId, ...params })
			if (this.removed) throw new Error('VideoDecoder has been removed')
			if (generation !== this.generation) throw new Error('VideoDecoder control was stopped')
			return complete(result)
		}).finally(() => {
			if (generation === this.generation) {
				this.pendingControls--
				if (command === 'start') this.pendingStarts--
			}
		})
		this.tail = operation.catch(() => {})
		return operation
	}
}
