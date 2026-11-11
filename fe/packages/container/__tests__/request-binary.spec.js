import http from 'node:http'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { createProxyRequestHandler } from '../src/services/request.js'

// Only replace target authorization: the production validator intentionally
// refuses loopback. HTTP, Axios, proxy serialization and callbacks stay real.
vi.mock('../../server/security.js', async (original) => ({
	...await original(),
	assertSafeTarget: async value => new URL(value),
}))
import { createProxyApp } from '../../server/index.js'
import { decodeRequestData } from '../../server/request-wire.js'

const bytes = Buffer.from([0, 255, 128, 195, 40, 13, 10])
let upstream; let proxy; let upstreamUrl; let proxyUrl; let received
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => {
	resolve(`http://127.0.0.1:${server.address().port}`)
}))
const close = server => new Promise(resolve => server.close(resolve))

beforeAll(async () => {
	upstream = http.createServer(async (req, res) => {
		const chunks = []
		for await (const chunk of req) chunks.push(chunk)
		received = Buffer.concat(chunks)
		res.setHeader('Set-Cookie', ['a=1', 'b=2'])
		res.statusCode = req.url === '/binary' ? 503 : 200
		res.end(req.url === '/binary' ? bytes : req.url === '/empty' ? '' : req.url === '/json' ? 'false' : 'not-json')
	})
	upstreamUrl = await listen(upstream)
	proxy = http.createServer(createProxyApp())
	proxyUrl = `${await listen(proxy)}/proxy`
})
afterAll(async () => { await Promise.all([close(upstream), close(proxy)]) })

function request(options, target = proxyUrl) {
	const events = []
	let returned
	const done = new Promise(resolve => {
		returned = createProxyRequestHandler(target).call({ createCallbackFunction: value => value }, {
			timeout: 5000,
			...options,
			success: result => events.push(['success', result]),
			fail: result => events.push(['fail', result]),
			complete: result => { events.push(['complete', result]); resolve(events) },
		})
	})
	expect(returned).toBeUndefined()
	return done
}

it('round trips arbitrary request and response bytes through the HTTP proxy on status 503', async () => {
	const backing = Uint8Array.from([99, ...bytes, 88])
	const events = await request({ url: `${upstreamUrl}/binary`, method: 'POST',
		data: new DataView(backing.buffer, 1, bytes.length), responseType: 'arraybuffer' })
	expect(received).toEqual(bytes)
	expect(events.map(([name]) => name)).toEqual(['success', 'complete'])
	const result = events[0][1]
	expect(result).toMatchObject({ errMsg: 'request:ok', statusCode: 503, cookies: ['a=1', 'b=2'] })
	expect(decodeRequestData(result.data)).toEqual(bytes)
	expect(events[1][1]).toBe(result)
})

it.each([['/json', false], ['/text', 'not-json']])('parses JSON or preserves invalid JSON text at %s', async (path, data) => {
	const events = await request({ url: upstreamUrl + path })
	expect(events[0]).toEqual(['success', expect.objectContaining({ data, errMsg: 'request:ok' })])
	expect(events[1][1]).toBe(events[0][1])
})

it('preserves empty binary responses and ignores a HEAD body', async () => {
	const events = await request({ url: `${upstreamUrl}/empty`, method: 'HEAD', data: 'ignored', responseType: 'ARRAYBUFFER' })
	expect(events[0][1].data).toEqual({ __diminaArrayBufferBase64: '' })
	expect(received.length).toBe(0)
})

it('returns proxy transport failures to fail and complete with one result', async () => {
	const events = await request({ url: 'invalid-url' })
	expect(events.map(([name]) => name)).toEqual(['fail', 'complete'])
	expect(events[0][1].errMsg).toMatch(/^request:fail /)
	expect(events[1][1]).toBe(events[0][1])
})

it('rejects malformed binary wire data before sending it upstream', () => {
	expect(() => decodeRequestData({ __diminaArrayBufferBase64: '!invalid' })).toThrow('Invalid binary request data')
})
