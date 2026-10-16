import { describe, expect, it, vi } from 'vitest'
import { CanvasBinaryPort } from '../src/core/canvas-binary-port.js'

function packet(type = 'canvas', sequence = 1, body = {}, buffers = [], extra = {}) {
	const header = new TextEncoder().encode(JSON.stringify({ type, requestId: 'page:' + sequence,
		deadline: Date.now() + 5000, body, byteLengths: buffers.map(value => value.byteLength), ...extra }))
	const result = new Uint8Array(4 + header.byteLength + buffers.reduce((sum, value) => sum + value.byteLength, 0))
	new DataView(result.buffer).setUint32(0, header.byteLength, true)
	result.set(header, 4)
	let offset = 4 + header.byteLength
	for (const buffer of buffers) { result.set(buffer, offset); offset += buffer.byteLength }
	return result.buffer
}
function harness() {
	const order = [], replies = [], published = [], listeners = new Set()
	const target = { eval: vi.fn(script => script === 'true' ? true : (order.push(script), '{"contexts":{},"typedArrays":[]}')),
		addEventListener: (_type, callback) => listeners.add(callback), removeEventListener: (_type, callback) => listeners.delete(callback),
		DiminaRenderBridge: { onMessage: vi.fn(body => { order.push('publish'); published.push(body) }) } }
	const actual = { contexts: { gl: { resources: [{ resourceId: 'real-buffer', metadata: { created: false } }] } }, typedArrays: [] }
	const flush = vi.fn(body => { order.push('query'); return actual })
	const port = { start: vi.fn(), close: vi.fn(), postMessage: vi.fn(message => replies.push(message)) }
	const channel = new CanvasBinaryPort(target, flush)
	expect(channel.connect('page')).toBe(true)
	channel.accept({ data: 'page', ports: [port] })
	return { channel, target, port, flush, order, replies, published, listeners, actual }
}

describe('native Canvas binary wire protocol', () => {
	it('keeps script, async byte publication and real query feedback in one FIFO', () => {
		const f = harness(), bytes = new Uint8Array([0, 255, 128, 17])
		expect(f.replies).toEqual(['ready\npage'])
		f.channel.receive(JSON.stringify({ type: 'script', script: 'before' }))
		const wire = packet('publish', 1, { name: 'canvasNodeFlush', data: { __canvasBinaryIndex: 0 }, empty: { __canvasBinaryIndex: 1 } }, [bytes, new Uint8Array(0)])
		f.channel.receive(wire)
		bytes.fill(33)
		expect([...f.published[0].data]).toEqual([0, 255, 128, 17])
		expect(f.published[0].empty.byteLength).toBe(0)
		f.channel.receive(packet('canvas', 2, { operations: ['getBufferParameter'] }))
		f.channel.receive(JSON.stringify({ type: 'script', script: 'after' }))
		expect(f.order).toEqual(['before', 'publish', 'query', 'after'])
		expect(JSON.parse(f.replies[1].slice('page:2\n'.length))).toEqual(f.actual)
		expect(f.flush).toHaveBeenCalledWith({ operations: ['getBufferParameter'] })
	})

	it('returns a query error without replaying a failed operation or losing later replies', () => {
		const f = harness()
		f.flush.mockImplementationOnce(() => { throw Error('real runtime failure') })
		f.channel.receive(packet('canvas', 1))
		expect(f.replies[1]).toBe('!page:1\nError: real runtime failure')
		f.channel.receive(packet('canvas', 2))
		expect(f.flush).toHaveBeenCalledTimes(2)
		expect(f.replies[2]).toBe('page:2\n' + JSON.stringify(f.actual))
	})

	it('rejects expired work before the runtime and ignores old page callbacks after replacement', () => {
		const f = harness(), stale = f.port.onmessage
		f.channel.receive(packet('canvas', 1, {}, [], { deadline: Date.now() - 1 }))
		expect(f.flush).not.toHaveBeenCalled()
		expect(f.replies[1]).toBe('!page:1\ncanvas query timed out')
		expect(f.channel.connect('next')).toBe(true)
		stale({ data: packet('canvas', 2) })
		expect(f.flush).not.toHaveBeenCalled()
		expect(f.port.close).toHaveBeenCalledOnce()
		f.channel.disconnect('page')
		expect(f.channel.token).toBe('next')
		f.channel.disconnect('next')
		expect(f.listeners.size).toBe(0)
	})

	it('disables the native handshake when the page evaluator is blocked', () => {
		const target = { eval: () => { throw Error('CSP') }, addEventListener: vi.fn() }
		const channel = new CanvasBinaryPort(target, vi.fn())
		expect(channel.connect('page')).toBe(false)
		expect(target.addEventListener).not.toHaveBeenCalled()
	})

	it.each([
		['repeated index', { a: { __canvasBinaryIndex: 0 }, b: { __canvasBinaryIndex: 0 } }, [new Uint8Array([1])]],
		['missing index', { a: { __canvasBinaryIndex: 1 } }, [new Uint8Array([1])]],
		['extra placeholder fields', { a: { __canvasBinaryIndex: 0, other: 1 } }, [new Uint8Array([1])]],
		['unreferenced bytes', {}, [new Uint8Array([1])]],
	])('rejects %s before any runtime call', (_label, body, buffers) => {
		const f = harness()
		f.channel.receive(packet('canvas', 1, body, buffers))
		expect(f.flush).not.toHaveBeenCalled()
		expect(f.replies.at(-1)).toMatch(/^error\n/)
		expect(f.port.close).toHaveBeenCalledOnce()
	})

	it('checks trailing bytes, invalid UTF8, excessive depth and node budgets before executing', () => {
		let nested = {}
		for (let i = 0; i < 130; i++) nested = { nested }
		const trailing = new Uint8Array(new Uint8Array(packet()).byteLength + 1)
		trailing.set(new Uint8Array(packet()))
		const invalid = packet()
		new Uint8Array(invalid)[4] = 0xFF
		for (const input of [trailing.buffer, invalid, packet('canvas', 1, nested), packet('canvas', 1, { data: Array(262144).fill(null) }),
			packet('canvas', 1, {}, [], { byteLengths: Array(4097).fill(0) }), packet('canvas', 1, {}, [], { byteLengths: [-1] })]) {
			const f = harness()
			f.channel.receive(input)
			expect(f.flush).not.toHaveBeenCalled()
			expect(f.replies.at(-1)).toMatch(/^error\n/)
		}
	})

	it('never replays a duplicate request and closes an async publication failure', () => {
		const f = harness(), input = packet()
		f.channel.receive(input); f.channel.receive(input)
		expect(f.flush).toHaveBeenCalledOnce()
		expect(f.replies.at(-1)).toMatch(/^error\npage\n.*duplicate/)
		const g = harness()
		g.target.DiminaRenderBridge.onMessage.mockImplementationOnce(() => { throw Error('publication failed') })
		g.channel.receive(packet('publish'))
		expect(g.port.close).toHaveBeenCalledOnce()
		expect(g.replies.at(-1)).toContain('publication failed')
	})
})
