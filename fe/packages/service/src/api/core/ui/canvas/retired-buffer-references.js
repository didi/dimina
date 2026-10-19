// The renderer keeps actual GL handles. Only a deleted proxy proven unbound
// becomes weak here; caller-held objects retain their identity and GL errors.
export class RetiredBufferReferences {
	constructor(enabled) {
		this.entries = new Map()
		this.sweepCursor = null
		this.active = enabled && typeof WeakRef === 'function'
	}

	get enabled() { return this.active }
	get(id) { return this.entries.get(id)?.reference.deref() }

	sweep() {
		// Bound allocation-time work. No finalizer batch runs on the JS thread.
		for (let remaining = 4; remaining > 0; remaining--) {
			this.sweepCursor ||= this.entries.entries()
			const next = this.sweepCursor.next()
			if (next.done) { this.sweepCursor = null; break }
			const [id, record] = next.value
			if (record.reference.deref() === undefined) this.entries.delete(id)
		}
	}

	remember(id, resource) {
		if (!this.active) return false
		this.sweep()
		try {
			this.entries.set(id, { reference: new WeakRef(resource) })
			return true
		}
		catch { return false }
	}

	dispose() {
		this.active = false
		this.sweepCursor = null
		this.entries.clear()
	}
}
