import { fontFaceKey, normalizeFontFace, resolveFontFaceSource } from '@dimina/common'

export class FontFaceLoader {
	constructor(target) {
		this.target = target
		this.epoch = 0
		this.slots = new Map()
		this.faces = new Set()
	}

	reset() {
		this.epoch++
		for (const { face } of this.faces) this.target.document.fonts.delete(face)
		this.faces.clear()
		this.slots.clear()
	}

	load(options) {
		const font = normalizeFontFace(options)
		const key = JSON.stringify(font)
		const epoch = this.epoch
		const slot = fontFaceKey(font)
		const previous = this.slots.get(slot)
		if (previous?.key === key) return previous.promise
		// Serialize replacements of the same family/descriptor, including slow older loads.
		const promise = Promise.resolve(previous?.promise).catch(() => {}).then(async () => {
			const { document, FontFace } = this.target
			if (!FontFace || !document.fonts) throw new Error('FontFace is unavailable')
			if (epoch !== this.epoch) throw new Error('page unloaded')
			const source = resolveFontFaceSource(font.source, document.baseURI)
			const face = await new FontFace(font.family, source, font.desc).load()
			if (epoch !== this.epoch) throw new Error('page unloaded')
			for (const old of this.faces) {
				if (old.slot === slot) {
					document.fonts.delete(old.face)
					this.faces.delete(old)
				}
			}
			document.fonts.add(face)
			this.faces.add({ slot, face })
		})
		const entry = { key, promise }
		this.slots.set(slot, entry)
		promise.catch(() => { if (this.slots.get(slot) === entry) this.slots.delete(slot) })
		return promise
	}
}
