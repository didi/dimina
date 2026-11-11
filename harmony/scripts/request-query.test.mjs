// Node regression for ArkTS HTTP dispatch; NetworkKit is mocked (no device traffic).
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import http from 'node:http'
import vm from 'node:vm'

const require = createRequire(new URL('../../fe/packages/compiler/package.json', import.meta.url))
const { transformSync } = require('esbuild')
const root = new URL('../dimina/src/main/ets/', import.meta.url)

function load(path, dependencies) {
  const { code } = transformSync(fs.readFileSync(new URL(path, root), 'utf8'), {
    loader: 'ts', format: 'cjs', target: 'es2022',
  })
  const module = { exports: {} }
  vm.runInNewContext(code, { module, exports: module.exports, require: name => {
    assert.ok(name in dependencies, `Unexpected dependency: ${name}`)
    return dependencies[name]
  } })
  return module.exports
}

function fixture(result = '', send) {
  const calls = []
  const { DMPMap } = load('Utils/DMPMap.ts', { '@kit.ArkTS': { ArrayList: class {} } })
  const network = { http: {
    RequestMethod: { GET: 'GET', HEAD: 'HEAD', DELETE: 'DELETE', POST: 'POST', PUT: 'PUT', PATCH: 'PATCH', OPTIONS: 'OPTIONS', TRACE: 'TRACE', CONNECT: 'CONNECT' },
    HttpDataType: { STRING: 0, ARRAY_BUFFER: 2 },
    createHttp: () => ({ request: async (url, options) => {
      calls.push({ url, options })
      if (send) return send(url, options)
      return { responseCode: 200, header: {}, result }
    }, destroy() {} }),
  } }
  const ark = { util: { Base64Helper: class {
    encodeToStringSync(bytes) { return Buffer.from(bytes).toString('base64') }
    decodeSync(text) { return new Uint8Array(Buffer.from(text, 'base64')) }
  } } }
  const params = load('HttpManager/DMPHttpParamsNext.ets', { '../Utils/DMPMap': { DMPMap } })
  const transport = load('HttpManager/DMPHttp.ets', { '@kit.NetworkKit': network })
  const { DMPNetServiceNext } = load('HttpManager/DMPNetServiceNext.ets', {
    './DMPHttpParamsNext': params, '../Utils/DMPMap': { DMPMap },
    '../EventTrack/DMPLogger': { DMPLogger: { d() {} } },
    '@kit.NetworkKit': network, './DMPHttp': transport, '@kit.ArkTS': ark,
  })
  return { calls, run: options => new DMPNetServiceNext(new DMPMap(options), 'test', '1').request() }
}

for (const method of ['GET', 'HEAD', 'DELETE']) {
  test(`${method} forwards normalized query without a JSON body and resolves an empty response`, async () => {
    const f = fixture()
    const url = 'https://example.com/api?old=1&transType=20%2C30&list=a&list=b'
    const pending = f.run({ url, method })
    assert.equal(f.calls.length, 1)
    assert.equal(f.calls[0].url, url)
    assert.equal(f.calls[0].options.method, method)
    assert.equal(f.calls[0].options.extraData, undefined)
    const response = await pending
    assert.equal(response.get('data'), '')
    assert.equal(response.get('statusCode'), 200)
  })
}

test('POST still sends its JSON body and parses JSON responses', async () => {
  const f = fixture('{"ok":true}')
  const response = await f.run({ url: 'https://example.com', method: 'POST', data: { page: 1 } })
  assert.equal(f.calls[0].options.method, 'POST')
  assert.equal(f.calls[0].options.extraData, '{"page":1}')
  assert.equal(response.get('data').ok, true)
})

test('unsupported methods reject instead of leaving the callback pending', async () => {
  const f = fixture()
  await assert.rejects(f.run({ url: 'https://example.com', method: 'INVALID' }), /unsupported method/)
  assert.equal(f.calls.length, 0)
})

test('binary responses take precedence over JSON and survive bridge JSON serialization', async () => {
  const bytes = new Uint8Array([0, 255, 128, 195, 40])
  const f = fixture(bytes.buffer)
  const result = await f.run({ url: 'https://example.com', responseType: 'arraybuffer' })
  assert.equal(f.calls[0].options.expectDataType, 2)
  const response = JSON.parse(JSON.stringify(result))
  assert.equal(response.errMsg, 'request:ok')
  assert.equal(response.data.__diminaArrayBufferBase64, Buffer.from(bytes).toString('base64'))
})

test('invalid JSON remains text and does not turn HTTP success into a transport failure', async () => {
  const f = fixture('not-json')
  const response = await f.run({ url: 'https://example.com', dataType: 'json' })
  assert.equal(response.get('data'), 'not-json')
})

test('raw request and response bytes round-trip through the real HTTP modules', async () => {
  const bytes = new Uint8Array([0, 255, 128, 195, 40, 13, 10])
  let received
  const server = http.createServer(async (request, response) => {
    const parts = []
    for await (const part of request) parts.push(part)
    received = Buffer.concat(parts)
    response.writeHead(429, { 'Content-Type': 'application/octet-stream' })
    response.end(bytes)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const f = fixture('', async (url, options) => {
      const response = await fetch(url, { method: options.method, body: options.extraData })
      return { responseCode: response.status, header: {}, result: await response.arrayBuffer() }
    })
    const result = await f.run({
      url: `http://127.0.0.1:${server.address().port}/bytes`, method: 'POST',
      responseType: 'arraybuffer', data: { __diminaArrayBufferBase64: Buffer.from(bytes).toString('base64') },
    })
    assert.deepEqual([...received], [...bytes])
    assert.equal(result.get('statusCode'), 429)
    assert.equal(result.get('data').__diminaArrayBufferBase64, Buffer.from(bytes).toString('base64'))
  } finally { await new Promise(resolve => server.close(resolve)) }
})
