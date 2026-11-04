import { fontFaceKey, normalizeFontFace } from '@dimina/common'
import message from './message'

// One registry per Service realm (one mini program), never shared across apps.
export class FontFaceRegistry {
	constructor(send) {
		this.send = send
		this.pages = new Map()
		this.globals = new Map()
		this.requests = new Map()
		this.nextId = 0
		this.supported = true
	}

	beginPage(bridgeId) {
		if (this.pages.has(bridgeId)) this.removePage(bridgeId)
		this.pages.set(bridgeId, { ready: false, loads: new Map() })
	}

	preparePage(bridgeId) {
		let page = this.pages.get(bridgeId)
		if (!page) {
			this.beginPage(bridgeId)
			page = this.pages.get(bridgeId)
		}
		page.ready = true
		for (const load of page.loads.values()) load.start()
		const replay = [...this.globals.values()].map(font => this.ensure(bridgeId, font))
		// Keep the existing synchronous startup path when there are no global fonts.
		// A failed optional font leaves the page usable with its CSS fallback.
		if (replay.length) return Promise.allSettled(replay).then((results) => {
			for (const result of results) {
				if (result.status === 'rejected') console.warn('[service] global font unavailable', bridgeId, result.reason.message)
			}
		})
	}

	removePage(bridgeId) {
		const page = this.pages.get(bridgeId)
		this.pages.delete(bridgeId)
		for (const load of page?.loads.values() || []) load.reject(new Error('page unloaded'))
		for (const [id, request] of this.requests) {
			if (request.bridgeId === bridgeId) {
				request.reject(new Error('page unloaded'))
				this.requests.delete(id)
			}
		}
	}

	ensure(bridgeId, font) {
		let page = this.pages.get(bridgeId)
		if (!page) {
			this.beginPage(bridgeId)
			page = this.pages.get(bridgeId)
		}
		const key = fontFaceKey(font)
		const fontKey = JSON.stringify(font)
		const previous = page.loads.get(key)
		if (previous?.fontKey === fontKey) return previous.promise
		if (previous && !previous.started) previous.reject(new Error('font load superseded'))
		let resolve, reject
		const promise = new Promise((yes, no) => { resolve = yes; reject = no })
		const requestId = `font_${++this.nextId}`
		const load = {
			promise, reject, fontKey,
			start: () => {
				if (load.started) return
				load.started = true
				this.requests.set(requestId, { bridgeId, resolve, reject })
				try {
					this.send({ type: 'invokeAPI', target: 'render', body: {
						bridgeId, name: 'loadFontFace', params: { ...font, requestId },
					} })
				}
				catch (error) {
					this.requests.delete(requestId)
					reject(error)
				}
			},
		}
		page.loads.set(key, load)
		promise.catch(() => { if (page.loads.get(key) === load) page.loads.delete(key) })
		if (page.ready) load.start()
		return promise
	}

	settle({ requestId, bridgeId, error }) {
		const request = this.requests.get(requestId)
		if (!request || request.bridgeId !== bridgeId) return
		this.requests.delete(requestId)
		if (error) request.reject(new Error(error))
		else request.resolve()
	}

	async load(options, bridgeId) {
		const font = normalizeFontFace(options)
		if (!this.supported) throw new Error('loadFontFace is only supported in mini program WebViews')
		if (!bridgeId) throw new Error('no page is available')
		if (!options.global) return this.ensure(bridgeId, font)
		const key = fontFaceKey(font)
		const previous = this.globals.get(key)
		this.globals.set(key, font)
		try {
			// Loading/prefetched siblings replay on their own ready handshake; they must
			// not hold an API call on the current page open indefinitely.
			const ready = [...this.pages].filter(([, page]) => page.ready).map(([id]) => id)
			await Promise.all([...new Set([...ready, bridgeId])].map(id => this.ensure(id, font)))
		}
		catch (error) {
			if (this.globals.get(key) === font) {
				if (previous) this.globals.set(key, previous)
				else this.globals.delete(key)
			}
			throw error
		}
	}
}

const fonts = new FontFaceRegistry(msg => message.send(msg))
message.on('fontFaceLoaded', result => fonts.settle(result))
export default fonts
