// Execute production Worker/render code with a WebView adapter. No device GPU is used.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import vm from 'node:vm'
const require = createRequire(new URL('../../fe/packages/compiler/package.json', import.meta.url))
const { transformSync } = require('esbuild')
const root = new URL('../dimina/src/main/ets/', import.meta.url)
function load(path, dependencies, extra = {}) {
  const { code } = transformSync(fs.readFileSync(new URL(path, root), 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022' })
  const module = { exports: {} }
  vm.runInNewContext(code, { module, exports: module.exports, Sendable: value => value, setTimeout, clearTimeout, ...extra, require: name => {
    assert.ok(name in dependencies, `Unexpected dependency: ${name}`)
    return dependencies[name]
  } })
  return module.exports
}
const noLog = { d() {}, e() {} }
const { DMPMap } = load('Utils/DMPMap.ts', { '@kit.ArkTS': { ArrayList: class {} } })
const messages = load('Service/DMPSendableObjects.ets', { '../Utils/DMPMap': { DMPMap }, '@kit.ArkTS': {}, '@ohos.app.ability.common': {} })
function render(native = { canvasUiRegister: () => 'test-canvas', canvasUiUnregister() {}, canvasUiPublish: () => true, canvasUiComplete() {} }) {
  const { DMPRender } = load('Render/DMPRender.ets', {
    'libdimina.so': native,
    '../Service/DMPSendableObjects': messages, '../DApp/DMPApp': {}, '../HybridContainer/DMPWebViewController': {}, '@kit.BasicServicesKit': {},
    '../Utils/DMPMap': { DMPMap }, '@ohos.base': {}, '../EventTrack/DMPLogger': { DMPLogger: noLog },
  })
  return new DMPRender({ appIndex: 9 })
}
function worker() {
  let invoke
  const posted = []
  const timers = new Map()
  let timerId = 0
  const port = { postMessage: value => posted.push(structuredClone(value)), callGlobalCallObjectMethod: () => 0 }
  load('Service/DMPWorker.ets', {
    '@kit.ArkTS': { worker: { workerPort: port } }, '../Bridges/DMPTSUtil': {}, '../Bridges/DMPWorkerModuleManager': {},
    '../EventTrack/DMPLogger': { DMPLogger: noLog }, '../EventTrack/Tags': { Tags: {} },
    './DMPJSEngine': { DMPJSEngine: class { initWithWorker(owner, callback) { invoke = callback } destroy() {} } },
    '../Utils/DMPMap': { DMPMap }, '../Utils/DMPContextUtils': { DMPWorkerContext: { sharedInstance: () => ({}) } },
    '../Bundle/Util/DMPRawFileUtils': {},
    '../Bundle/Util/DMPFileUrlConvertor': { DMPVirtualFileConfig: { configure() {} } }, './DMPSendableObjects': messages,
  }, { setTimeout: callback => { const id = ++timerId; timers.set(id, callback); return id }, clearTimeout: id => timers.delete(id) })
  return { port, posted, timers, init: () => port.onmessage({ data: { command: 'init', appIndex: 7 } }),
    query: (body, type = 1) => {
      const message = { type: 'canvasNodeSync', target: 'container', body }
      return invoke(type, 0, type === 6 ? message : JSON.stringify(message))
    } }
}

test('native invocation can wait while the ArkTS Worker remains free to receive the matching render reply', async () => {
  const f = worker(); await f.init()
  const pending = f.query({ bridgeId: 3, params: { nodeId: 'canvas' } })
  assert.equal(typeof pending.then, 'function')
  const request = f.posted[0]
  assert.equal(request.type, 'canvasSync')
  await f.port.onmessage({ data: new messages.WorkerCanvasResult(request.requestId + 1, 'stale') })
  assert.equal(f.timers.size, 1)
  const feedback = JSON.stringify({ queries: { location: 0, uniforms: { name: 'color', size: 1, type: 35666 } }, typedArrays: { pixels: { __canvasTypedArray: 'Uint8Array', base64: '/wAA/w==' } } })
  await f.port.onmessage({ data: new messages.WorkerCanvasResult(request.requestId, feedback) })
  assert.equal(await pending, feedback)
  assert.equal(f.timers.size, 0)
})

test('timeouts and teardown settle a pending query and ignore late replies', async () => {
  const f = worker(); await f.init()
  const pending = f.query({ bridgeId: 3 })
  f.timers.values().next().value()
  assert.match(await pending, /timed out/)
  await f.port.onmessage({ data: new messages.WorkerCanvasResult(f.posted[0].requestId, '{}') })
  const second = f.query({ bridgeId: 3 })
  await f.port.onmessage({ data: { command: 'destroy' } })
  assert.match(await second, /destroyed/)
})

test('queries run after submitted drawing commands and return renderer metadata and binary feedback', async () => {
  const r = render(), scripts = []
  const controller = { isControllerAttached: true, runJavaScript(script, callback) {
    scripts.push(script)
    callback(null, JSON.stringify({ queries: { location: 2 }, typedArrays: { bytes: { base64: 'AQID' } } }))
  } }
  r.setController(3, controller)
  r.fromServiceNext('{"type":"canvasNodeFlush"}', 3)
  const result = await r.canvasNodeSync(new DMPMap({ bridgeId: 3, params: { nodeId: 'canvas' } }))
  assert.equal(JSON.parse(result).queries.location, 2)
  assert.match(scripts[0], /canvasNodeFlush/)
  assert.match(scripts[1], /__diminaCanvasSync/)
})

test('missing, detached, closed and failing WebViews produce explicit query failures', async () => {
  const r = render(), body = new DMPMap({ bridgeId: 3 })
  assert.match(await r.canvasNodeSync(body), /unavailable/)
  r.setController(3, { isControllerAttached: false })
  assert.match(await r.canvasNodeSync(body), /unavailable/)
  r.setController(3, { isControllerAttached: true, runJavaScript(script, callback) { r.removeController(3); callback(null, '{}') } })
  assert.match(await r.canvasNodeSync(body), /closed/)
  r.setController(3, { isControllerAttached: true, runJavaScript() { throw new Error('WebView failed') } })
  assert.match(await r.canvasNodeSync(body), /WebView failed/)
})

function wrapperFixture() {
  const posted = [], timers = new Map(), calls = [], deadlines = []
  let terminated = 0, timerId = 0
  class Worker {
    registerGlobalCallObject() {}
    postMessage(message) { posted.push(message) }
    postMessageWithSharedSendable(message) { posted.push(message) }
    terminate() { terminated++ }
  }
  const barrier = load('Service/DMPWorkerFlushBarrier.ets', {})
  const { DMPWorkerWrapper } = load('Service/DMPWorkerWrapper.ets', {
    '@kit.ArkTS': { worker: { ThreadWorker: Worker }, util: { TextDecoder: { create: () => ({ decodeToString: bytes => new TextDecoder().decode(bytes) }) } } },
    '../DApp/DMPAppManager': { DMPAppManager: { sharedInstance: () => ({ getApp: () => ({ render: { canvasNodeSync: async (body, deadline) => { calls.push(body.toJSON()); deadlines.push(deadline); return '{"queries":{"location":2}}' } } }) }) } },
    '../Utils/DMPMap': { DMPMap }, '../DApp/DMPApp': {}, '../EventTrack/DMPLogger': { DMPLogger: noLog },
    '../EventTrack/Tags': { Tags: {} }, './DMPChannelProxyNext': {}, './DMPSendableObjects': messages,
    './DMPWorkerCaller': { DMPWorkerCaller: class {} }, './DMPWorkerFlushBarrier': barrier,
    '@ohos.app.ability.common': {}, '../Utils/DMPContextUtils': {}, '../Bundle/Util/DMPFileUrlConvertor': {},
  }, { setTimeout: callback => { const id = ++timerId; timers.set(id, callback); return id }, clearTimeout: id => timers.delete(id) })
  return { wrapper: new DMPWorkerWrapper(7), posted, calls, deadlines, timers, terminated: () => terminated }
}

test('container returns real feedback and rejects an expired query before executing GPU commands', async () => {
  const f = wrapperFixture()
  const request = new messages.WorkerCanvasRequest(1, '{"bridgeId":3}')
  f.wrapper.w.onmessage({ data: request })
  await Promise.resolve(); await Promise.resolve()
  assert.equal(f.posted[0].requestId, 1)
  assert.equal(JSON.parse(f.posted[0].result).queries.location, 2)
  request.deadline = 0
  f.wrapper.w.onmessage({ data: request })
  assert.equal(f.calls.length, 1)
  assert.match(f.posted.at(-1).result, /timed out/)
})

test('teardown lets the Worker dispose native resources before termination; no later queries reach the renderer', async () => {
  const f = wrapperFixture()
  await f.wrapper.destroy()
  assert.equal(f.posted.at(-1).command, 'destroy')
  assert.equal(f.terminated(), 0)
  f.wrapper.w.onmessage({ data: new messages.WorkerCanvasRequest(1, '{"bridgeId":3}') })
  assert.equal(f.calls.length, 0)
  f.wrapper.w.onmessage({ data: { type: 'destroyed' } })
  assert.equal(f.terminated(), 1)
  assert.equal(f.timers.size, 0)
  await f.wrapper.destroy()
  assert.equal(f.terminated(), 1)
})

test('quoted ArkWeb string results are unwrapped and invalid feedback fails explicitly', async () => {
  const r = render(), body = new DMPMap({ bridgeId: 3 })
  r.setController(3, { isControllerAttached: true, runJavaScript(script, callback) { callback(null, JSON.stringify('{"queries":{"location":0}}')) } })
  assert.equal(JSON.parse(await r.canvasNodeSync(body)).queries.location, 0)
  for (const result of ['null', 'undefined', '"null"', '1']) {
    r.setController(3, { isControllerAttached: true, runJavaScript(script, callback) { callback(null, result) } })
    assert.ok(JSON.parse(await r.canvasNodeSync(body)).error)
  }
})


test('structured native canvas messages retain the exact payload and asynchronous reply path', async () => {
  const f = worker(); await f.init()
  const body = { bridgeId: 3, params: { nodeId: '画布\uD800', feedback: true,
    operations: [{ op: 'contextCall', method: 'texImage2D', args: [
      { __canvasTypedArray: 'Uint8Array', encoding: 'rle32-v1', byteLength: 6220800, base64: 'A'.repeat(512 * 1024) },
      'quote" and slash\\ and newline\n',
    ] }] } }
  const pending = f.query(body, 6)
  assert.equal(typeof pending.then, 'function')
  const request = f.posted[0]
  assert.equal(request.type, 'canvasSync')
  assert.equal(request.body, '')
  assert.deepEqual(request.structuredBody, body)
  const feedback = JSON.stringify({ contexts: { texture: { resources: [{ resourceId: 'buffer', metadata: { created: true } }] } } })
  await f.port.onmessage({ data: new messages.WorkerCanvasResult(request.requestId, feedback) })
  assert.equal(await pending, feedback)
  assert.equal(f.timers.size, 0)
})

test('structured canvas queries settle on teardown and ignore a late render reply', async () => {
  const f = worker(); await f.init()
  const pending = f.query({ bridgeId: 3, params: { nodeId: 'canvas', operations: [] } }, 6)
  const request = f.posted[0]
  await f.port.onmessage({ data: new messages.WorkerRequest('destroy', -1, new messages.Payload()) })
  assert.ok((await pending).includes('destroyed'))
  await f.port.onmessage({ data: new messages.WorkerCanvasResult(request.requestId, '{}') })
  assert.equal(f.timers.size, 0)
})


test('the UI wrapper routes cloned structured and legacy canvas bodies through the same FIFO', async () => {
  const f = wrapperFixture()
  const body = { bridgeId: 3, params: { nodeId: 'canvas\u0000\uD800', operations: [
    { op: 'contextCall', method: 'texImage2D', args: [{ __canvasTypedArray: 'Uint8Array',
      encoding: 'rle32-v1', byteLength: 6220800, base64: 'A'.repeat(512 * 1024) }] },
  ] } }
  const legacy = structuredClone(new messages.WorkerCanvasRequest(1, JSON.stringify(body)))
  const structured = structuredClone(new messages.WorkerCanvasRequest(2, '', body))
  body.params.nodeId = 'mutated after posting'
  f.wrapper.w.onmessage({ data: legacy })
  f.wrapper.w.onmessage({ data: structured })
  await Promise.resolve(); await Promise.resolve()
  assert.equal(f.calls.length, 2)
  assert.equal(JSON.stringify(f.calls[0]), JSON.stringify(f.calls[1]))
  assert.equal(f.calls[1].params.nodeId, 'canvas\u0000\uD800')
  assert.deepEqual(f.posted.map(result => result.requestId), [1, 2])
  assert.equal(f.calls[1].params.operations[0].args[0].base64.length, 512 * 1024)
})


test('the UI wrapper retains the Worker deadline instead of granting a new query window', async () => {
  const f = wrapperFixture()
  const request = new messages.WorkerCanvasRequest(1, '', { bridgeId: 3 })
  request.deadline = Date.now() + 100
  f.wrapper.w.onmessage({ data: structuredClone(request) })
  await Promise.resolve(); await Promise.resolve()
  assert.equal(f.deadlines[0], request.deadline)
})


test('expired caller deadlines fail before submitting a native Canvas query', async () => {
  const r = render(); let submitted = 0
  r.setController(3, { isControllerAttached: true, runJavaScript() { submitted++ } })
  const feedback = await r.canvasNodeSync(new DMPMap({ bridgeId: 3 }), Date.now() - 1)
  assert.match(JSON.parse(feedback).error, /timed out/); assert.equal(submitted, 0)
})

function uiFixture() {
  const routes = [], closed = [], published = [], completed = [], scripts = []
  let reject = false
  const native = {
    canvasUiRegister(owner, page, callback) {
      const token = `ui-${routes.length + 1}`; routes.push({ owner, page, callback, token }); return token
    },
    canvasUiUnregister(owner, page, token) { closed.push({ owner, page, token }) },
    canvasUiPublish(owner, page, script) { published.push({ owner, page, script }); return !reject },
    canvasUiComplete(id, json, error) { completed.push({ id, json, error }) },
  }
  const r = render(native)
  const controller = { isControllerAttached: true, runJavaScript(script, callback) { scripts.push({ script, callback }) } }
  r.setController(3, controller)
  const body = new DMPMap({ bridgeId: 3, params: { nodeId: 'canvas', operations: [] } })
  return { r, controller, body, routes, closed, published, completed, scripts,
    reject() { reject = true },
    async activate() {
      const query = r.canvasNodeSync(body)
      assert.equal(routes.length, 0, 'the initial real query has not completed')
      scripts.at(-1).callback(null, '{"contexts":{},"typedArrays":[]}')
      assert.equal(JSON.parse(await query).error, undefined)
      assert.equal(routes.length, 1); assert.equal(routes[0].owner, 9); assert.equal(routes[0].page, 3)
    },
  }
}

test('native UI routing starts after real feedback and forwards all later scripts into the same channel', async () => {
  const f = uiFixture(); await f.activate()
  f.r.executeScript('after query', 3)
  assert.deepEqual(f.published, [{ owner: 9, page: 3, script: 'after query' }])
  assert.equal(f.scripts.length, 1)
  f.routes[0].callback('ui-1:1', 'real query')
  const feedback = { contexts: { gl: { resources: [{ resourceId: 'buffer', metadata: { created: false } }] } }, typedArrays: [] }
  f.scripts.at(-1).callback(null, JSON.stringify(JSON.stringify(feedback)))
  assert.deepEqual(JSON.parse(f.completed[0].json), feedback)
  assert.equal(f.completed[0].error, '')
})

test('a reload of the same controller cancels its generation before a late result can succeed', async () => {
  const f = uiFixture(); await f.activate()
  f.routes[0].callback('ui-1:1', 'old query'); const late = f.scripts.at(-1).callback
  f.r.invalidateCanvasUi(3, f.controller)
  late(null, '{"contexts":{},"typedArrays":[]}')
  assert.equal(f.closed.length, 1)
  assert.match(f.completed[0].error, /closed/)
  const count = f.scripts.length
  f.routes[0].callback('ui-1:2', 'queued old script')
  assert.equal(f.scripts.length, count)
})

test('the initial query cannot activate after its document generation changes', async () => {
  const f = uiFixture(); const pending = f.r.canvasNodeSync(f.body); const late = f.scripts.at(-1).callback
  f.r.invalidateCanvasUi(3, f.controller); late(null, '{"contexts":{},"typedArrays":[]}')
  assert.match(JSON.parse(await pending).error, /closed/); assert.equal(f.routes.length, 0)
})

test('a timed out initial query never activates from late feedback', async () => {
  const f = uiFixture(); const pending = f.r.canvasNodeSync(f.body, Date.now() + 20)
  const late = f.scripts.at(-1).callback
  assert.match(JSON.parse(await pending).error, /timed out/)
  late(null, '{"contexts":{},"typedArrays":[]}'); assert.equal(f.routes.length, 0)
})

test('a stale lifecycle event cannot cancel a replacement controller channel', async () => {
  const f = uiFixture(); await f.activate()
  const old = f.controller
  const next = { isControllerAttached: true, runJavaScript(script, callback) { f.scripts.push({ script, callback }) } }
  f.r.setController(3, next)
  const query = f.r.canvasNodeSync(f.body); f.scripts.at(-1).callback(null, '{"contexts":{},"typedArrays":[]}'); await query
  f.r.invalidateCanvasUi(3, old)
  assert.equal(f.closed.length, 1)
  f.routes[1].callback('ui-2:1', 'new query'); f.scripts.at(-1).callback(null, '{"contexts":{},"typedArrays":[]}')
  assert.equal(f.completed.at(-1).error, '')
})

test('a ready UI channel failure does not replay through the legacy evaluator', async () => {
  const f = uiFixture(); await f.activate(); f.reject()
  f.r.executeScript('attempt', 3)
  assert.equal(f.published.length, 1); assert.equal(f.scripts.length, 1)
})

test('direct UI feedback rejects empty/null data and preserves actual context errors', async () => {
  const f = uiFixture(); await f.activate()
  for (const result of ['null', '{}', '[]']) {
    f.routes[0].callback(`ui-1:${f.completed.length + 1}`, 'query')
    f.scripts.at(-1).callback(null, result)
    assert.ok(f.completed.at(-1).error)
  }
  const real = { contexts: { gl: { contextLost: true, errors: [0x9242] } }, typedArrays: [] }
  f.routes[0].callback('ui-1:9', 'query'); f.scripts.at(-1).callback(null, JSON.stringify(real))
  assert.deepEqual(JSON.parse(f.completed.at(-1).json), real)
})
