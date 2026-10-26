import { CanvasBinaryPort } from './canvas-binary-port'

// WKWebView's public script API cannot accept NSData. Native serves one owned
// packet through its page-scoped URL handler, then awaits actual GL feedback.
export function createCanvasResourceReceiver(target, flush) {
	if (typeof target.fetch !== 'function' || typeof TextDecoder !== 'function') return null
	const reader = new CanvasBinaryPort(target, flush)
	reader.decoder = new TextDecoder('utf-8', { fatal: true })
	let generation = 0
	const receive = async url => {
		const expected = generation
		if (typeof url !== 'string' || !/^dimina:\/\/\/__canvas_packet\/[A-Za-z0-9-]+$/.test(url)) throw new Error('invalid canvas packet URL')
		const response = await target.fetch(url, { cache: 'no-store' })
		const { command, buffers } = reader.read(await response.arrayBuffer())
		if (generation !== expected) throw new Error('canvas page replaced')
		// A synchronous query can expire while its caller waits. An admitted
		// publication has no waiting caller: keep it in FIFO order even after a
		// long queue wait. Native bounds its execution time when the job starts.
		if (!Number.isSafeInteger(command.deadline)
			|| (command.type === 'canvas' && Date.now() >= command.deadline)) throw new Error('canvas packet expired')
		const body = reader.restore(command.body, buffers)
		if (command.type === 'canvas') return flush(body)
		if (command.type === 'publish') { target.DiminaRenderBridge.onMessage(body); return null }
		throw new Error('invalid canvas packet command')
	}
	receive.cancel = () => { generation++ }
	return receive
}
