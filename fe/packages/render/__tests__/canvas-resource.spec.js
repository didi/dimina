import { expect, it, vi } from 'vitest'
import { createCanvasResourceReceiver } from '../src/core/canvas-resource'

function packet(type, bytes, deadline = Date.now() + 5000) {
	const header = new TextEncoder().encode(JSON.stringify({ type, deadline,
		body: { bytes: { __canvasBinaryIndex: 0 } }, byteLengths: [bytes.length] }))
	const data = new Uint8Array(4 + header.length + bytes.length)
	new DataView(data.buffer).setUint32(0, header.length, true)
	data.set(header, 4); data.set(bytes, header.length + 4)
	return data.buffer
}
function harness(data) {
	const flush = vi.fn(body => ({ actual: [...body.bytes] }))
	const target = { fetch: vi.fn(async () => ({ arrayBuffer: async () => data })),
		DiminaRenderBridge: { onMessage: vi.fn() } }
	return { target, flush, receive: createCanvasResourceReceiver(target, flush) }
}
const url = 'dimina:///__canvas_packet/page-uuid'

it('delivers exact binary bytes and returns actual query feedback', async () => {
	const f = harness(packet('canvas', [0, 255, 128, 17]))
	expect(await f.receive(url)).toEqual({ actual: [0, 255, 128, 17] })
	expect(f.flush).toHaveBeenCalledOnce()
	expect(f.target.fetch).toHaveBeenCalledWith(url, { cache: 'no-store' })
})
it('awaits the real resource before executing a publication', async () => {
	const f = harness(null)
	let release
	f.target.fetch.mockImplementation(() => new Promise(resolve => { release = resolve }))
	const finished = f.receive(url)
	expect(f.target.DiminaRenderBridge.onMessage).not.toHaveBeenCalled()
	release({ arrayBuffer: async () => packet('publish', [2, 4, 8]) })
	await finished
	expect([...f.target.DiminaRenderBridge.onMessage.mock.calls[0][0].bytes]).toEqual([2, 4, 8])
	expect(f.flush).not.toHaveBeenCalled()
})
it('rejects expired or malformed packets without executing GL', async () => {
	for (const data of [packet('canvas', [1], Date.now() - 1), packet('canvas', [1]).slice(0, -1), new ArrayBuffer(0)]) {
		const f = harness(data)
		await expect(f.receive(url)).rejects.toThrow()
		expect(f.flush).not.toHaveBeenCalled()
	}
})
it('keeps admitted publications ordered after their original query deadline', async () => {
	const f = harness(packet('publish', [2, 4, 8], Date.now() - 1))
	await f.receive(url)
	expect([...f.target.DiminaRenderBridge.onMessage.mock.calls[0][0].bytes]).toEqual([2, 4, 8])
	expect(f.flush).not.toHaveBeenCalled()
})
it('propagates resource and GL failures without replay', async () => {
	const f = harness(packet('canvas', [1]))
	f.flush.mockImplementation(() => { throw new Error('actual driver failure') })
	await expect(f.receive(url)).rejects.toThrow('actual driver failure')
	expect(f.flush).toHaveBeenCalledOnce()
	f.target.fetch.mockRejectedValue(new Error('page disposed'))
	await expect(f.receive(url)).rejects.toThrow('page disposed')
	expect(f.flush).toHaveBeenCalledOnce()
})
it.each(['canvas', 'publish'])('rejects a late %s resource after page replacement before executing GL', async type => {
	const f = harness(null)
	let release
	f.target.fetch.mockImplementation(() => new Promise(resolve => { release = resolve }))
	const finished = f.receive(url)
	f.receive.cancel()
	release({ arrayBuffer: async () => packet(type, [9]) })
	await expect(finished).rejects.toThrow('page replaced')
	expect(f.flush).not.toHaveBeenCalled()
	expect(f.target.DiminaRenderBridge.onMessage).not.toHaveBeenCalled()
})
it.each(['https://example.com/bytes', 'dimina:///other', 'dimina:///__canvas_packet/../secret', url + '?other=1'])(
	'rejects unrelated resource URL %s', async input => {
		const f = harness(packet('canvas', [1]))
		await expect(f.receive(input)).rejects.toThrow('invalid canvas packet URL')
		expect(f.target.fetch).not.toHaveBeenCalled()
	})
