// Track WebGL1 buffer attachments using actual driver readback. A deleted buffer
// stays reachable through an inactive VAO until the application detaches it.
export class CanvasBufferReferences {
	constructor(gl) {
		this.gl = gl
		this.vaos = new Map([[null, new Map()]])
		this.buffers = new Map()
		this.counts = new Map()
		this.deleted = new Set()
		this.retired = new Set()
		this.extension = null
		this.uncertain = false
		if (typeof gl.createVertexArray === 'function' || typeof gl.bindBufferBase === 'function') this.invalidate()
		try {
			this.maxAttributes = gl.getParameter(gl.MAX_VERTEX_ATTRIBS)
			if (!Number.isInteger(this.maxAttributes) || this.maxAttributes <= 0) this.invalidate()
		}
		catch { this.invalidate() }
	}

	invalidate() { this.uncertain = true; this.retired.clear() }

	current() {
		const vao = this.extension ? this.gl.getParameter(this.extension.VERTEX_ARRAY_BINDING_OES) : null
		if (!this.vaos.has(vao)) { this.invalidate(); return undefined }
		return vao
	}

	release(buffer) {
		if (this.deleted.has(buffer) && !this.counts.get(buffer)) {
			this.retired.add(this.buffers.get(buffer))
			this.deleted.delete(buffer)
			this.buffers.delete(buffer)
			this.counts.delete(buffer)
		}
	}

	set(vao, slot, buffer) {
		const slots = this.vaos.get(vao), previous = slots.get(slot)
		if (previous === buffer) return
		if (previous) {
			const count = this.counts.get(previous) - 1
			if (count) this.counts.set(previous, count); else this.counts.delete(previous)
			this.release(previous)
		}
		if (buffer) { slots.set(slot, buffer); this.counts.set(buffer, (this.counts.get(buffer) || 0) + 1) }
		else slots.delete(slot)
	}

	before(method, args) {
		if (this.uncertain) return
		if (method === 'vertexAttribPointer' || method === 'bindBuffer') {
			const value = args[0]
			// Unusual WebIDL coercions can execute user code. Keep conservative
			// ownership instead of coercing them a second time for bookkeeping.
			if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) this.invalidate()
		}
	}

	after(method, args, result, id, owns, contextId) {
		if (this.uncertain) return
		try {
			if (method === 'createBuffer' && result && id) this.buffers.set(result, { id, contextId })
			else if (method === 'vertexAttribPointer' && args[0] < this.maxAttributes) {
				const vao = this.current()
				if (!this.uncertain) this.set(vao, args[0], this.gl.getVertexAttrib(args[0], this.gl.VERTEX_ATTRIB_ARRAY_BUFFER_BINDING))
			}
			else if (method === 'bindBuffer' && args[0] === this.gl.ELEMENT_ARRAY_BUFFER) {
				const vao = this.current()
				if (!this.uncertain) this.set(vao, 'element', this.gl.getParameter(this.gl.ELEMENT_ARRAY_BUFFER_BINDING))
			}
			else if (method === 'deleteBuffer' && owns && this.buffers.has(args[0]) && !this.deleted.has(args[0])) {
				const buffer = args[0], vao = this.current()
				if (this.uncertain || this.gl.isBuffer(buffer)) return
				this.deleted.add(buffer)
				for (const [slot, value] of [...this.vaos.get(vao)]) if (value === buffer) this.set(vao, slot, null)
				this.release(buffer)
			}
		}
		catch { this.invalidate() }
	}

	extensionEnabled(extension) {
		if (extension && typeof extension.createVertexArrayOES === 'function'
			&& Number.isInteger(extension.VERTEX_ARRAY_BINDING_OES)) this.extension = extension
	}

	extensionCall(extension, method, args, result, owns) {
		if (this.uncertain) return
		try {
			if (extension === this.extension && method === 'createVertexArrayOES' && result) this.vaos.set(result, new Map())
			else if (extension === this.extension && method === 'deleteVertexArrayOES' && owns && args[0] && this.vaos.has(args[0])) {
				if (extension.isVertexArrayOES(args[0])) return
				for (const slot of [...this.vaos.get(args[0]).keys()]) this.set(args[0], slot, null)
				this.vaos.delete(args[0])
			}
			else if (!['bindVertexArrayOES', 'isVertexArrayOES', 'vertexAttribDivisorANGLE',
				'drawArraysInstancedANGLE', 'drawElementsInstancedANGLE'].includes(method)
				&& !method.startsWith('get') && !method.startsWith('is') && !method.startsWith('draw')
				&& !['createQueryEXT', 'deleteQueryEXT', 'beginQueryEXT', 'endQueryEXT', 'queryCounterEXT'].includes(method)) this.invalidate()
		}
		catch { this.invalidate() }
	}

	drain() {
		const ids = []
		if (this.uncertain) return ids
		for (const record of this.retired) {
			this.retired.delete(record)
			if (record) ids.push(record)
			if (ids.length === 128) break
		}
		return ids
	}
}
