const MAX_BYTES = 64 * 1024 * 1024
const MAX_BUFFERS = 4096
const MAX_NODES = 262144
const MAX_DEPTH = 128

// All commands use one port FIFO. Feedback is produced by the actual runtime.
export class CanvasBinaryPort {
	constructor(target, flush) {
		this.target = target
		this.flush = flush
		this.token = null
		this.port = null
		this.sequence = 0
		this.listener = event => this.accept(event)
	}

	connect(token) {
		if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(token)) return false
		try {
			// Pending scripts use the same evaluator as the legacy route. A CSP
			// which disallows it must select legacy before a port becomes active.
			if (this.target.eval('true') !== true) return false
			this.decoder = new TextDecoder('utf-8', { fatal: true })
		}
		catch { return false }
		this.disconnect(this.token)
		this.token = token
		this.sequence = 0
		this.target.addEventListener('message', this.listener)
		return true
	}

	accept(event) {
		if (!this.token || this.port || event.data !== this.token || event.ports?.length !== 1) return
		const token = this.token, port = event.ports[0]
		if (!port || typeof port.postMessage !== 'function') return
		this.port = port
		port.onmessage = event => { if (this.token === token && this.port === port) this.receive(event.data) }
		port.onmessageerror = () => { if (this.token === token && this.port === port) this.fail('invalid canvas message') }
		try { port.start?.(); port.postMessage('ready\n' + token) }
		catch (error) { this.fail(String(error)) }
	}

	read(data) {
		if (typeof data === 'string') {
			if (data.length > MAX_BYTES) throw new Error('canvas packet budget exceeded')
			const command = JSON.parse(data)
			if (!command || !['script', 'legacy'].includes(command.type) || typeof command.script !== 'string')
				throw new Error('invalid canvas script')
			return { command, buffers: [] }
		}
		if (!(data instanceof ArrayBuffer) || data.byteLength < 4 || data.byteLength > MAX_BYTES)
			throw new Error('invalid canvas binary packet')
		const length = new DataView(data).getUint32(0, true)
		if (length > data.byteLength - 4) throw new Error('invalid canvas binary header')
		const command = JSON.parse(this.decoder.decode(new Uint8Array(data, 4, length)))
		if (!command || !['canvas', 'publish'].includes(command.type) || !Array.isArray(command.byteLengths)
			|| command.byteLengths.length > MAX_BUFFERS) throw new Error('invalid canvas buffer lengths')
		let offset = 4 + length
		const buffers = []
		for (const size of command.byteLengths) {
			if (!Number.isSafeInteger(size) || size < 0 || size > data.byteLength - offset)
				throw new Error('invalid canvas buffer size')
			buffers.push(new Uint8Array(data, offset, size))
			offset += size
		}
		if (offset !== data.byteLength) throw new Error('trailing canvas packet bytes')
		return { command, buffers }
	}

	restore(body, buffers) {
		const used = new Set()
		let nodes = 0
		const visit = (value, depth) => {
			if (++nodes > MAX_NODES || depth > MAX_DEPTH) throw new Error('canvas value exceeds budget')
			if (!value || typeof value !== 'object') return value
			if (Object.hasOwn(value, '__canvasBinaryIndex')) {
				const index = value.__canvasBinaryIndex
				if (Object.keys(value).length !== 1 || !Number.isSafeInteger(index) || index < 0
					|| index >= buffers.length || used.has(index)) throw new Error('invalid canvas buffer reference')
				used.add(index)
				return buffers[index]
			}
			for (const key of Object.keys(value)) value[key] = visit(value[key], depth + 1)
			return value
		}
		if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid canvas body')
		const result = visit(body, 0)
		if (used.size !== buffers.length) throw new Error('unreferenced canvas buffer')
		return result
	}

	requestId(id) {
		if (typeof id !== 'string' || !id.startsWith(this.token + ':')) throw new Error('invalid canvas request ID')
		const text = id.slice(this.token.length + 1)
		const sequence = Number(text)
		if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(sequence) || sequence <= this.sequence)
			throw new Error('duplicate or invalid canvas request ID')
		this.sequence = sequence
		return id
	}

	receive(data) {
		if (!this.port || !this.token) return
		let command, body, id
		try {
			const packet = this.read(data)
			command = packet.command
			if (command.type === 'script') {
				if (command.ack === true) id = this.requestId(command.requestId)
				this.target.eval(command.script)
				if (id) this.reply(id, 'null')
				return
			}
			id = this.requestId(command.requestId)
			if (command.type !== 'legacy') body = this.restore(command.body, packet.buffers)
			if (command.type === 'canvas' || (command.type === 'publish' && command.ack === true)) {
				if (!Number.isSafeInteger(command.deadline)) throw new Error('invalid canvas deadline')
				if (Date.now() >= command.deadline) { this.reply(id, '', 'canvas query timed out'); return }
			}
		}
		catch (error) { this.fail(String(error)); return }
		try {
			if (command.type === 'publish') {
				this.target.DiminaRenderBridge.onMessage(body)
				if (command.ack === true) this.reply(id, 'null')
				return
			}
			const result = command.type === 'legacy' ? this.target.eval(command.script) : JSON.stringify(this.flush(body))
			if (typeof result !== 'string') throw new Error('invalid canvas feedback')
			this.reply(id, result)
		}
		catch (error) {
			if (command.type === 'publish') this.fail(String(error))
			else this.reply(id, '', String(error))
		}
	}

	reply(id, json, error) {
		try { this.port?.postMessage((error ? '!' : '') + id + '\n' + (error || json)) }
		catch (error) { this.fail(String(error)) }
	}

	fail(error) {
		try { this.port?.postMessage('error\n' + this.token + '\n' + error) }
		catch { /* The native owner will also time out a disconnected port. */ }
		finally { this.disconnect(this.token) }
	}

	disconnect(token) {
		if (token !== this.token) return
		this.target.removeEventListener('message', this.listener)
		if (this.port) {
			this.port.onmessage = null
			this.port.onmessageerror = null
			try { this.port.close?.() } catch { /* Already closed by native. */ }
		}
		this.port = null
		this.token = null
		this.sequence = 0
	}
}
