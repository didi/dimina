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
function render() {
  const { DMPRender } = load('Render/DMPRender.ets', {
    '../Service/DMPSendableObjects': messages, '../DApp/DMPApp': {}, '../HybridContainer/DMPWebViewController': {}, '@kit.BasicServicesKit': {},
    '../Utils/DMPMap': { DMPMap }, '@ohos.base': {}, '../EventTrack/DMPLogger': { DMPLogger: noLog },
  })
  return new DMPRender({})
}
function worker() {
  let invoke
  const posted = []
  const timers = new Map()
  let timerId = 0
  const port = { postMessage: value => posted.push(value), callGlobalCallObjectMethod: () => 0 }
  load('Service/DMPWorker.ets', {
    '@kit.ArkTS': { worker: { workerPort: port } }, '../Bridges/DMPTSUtil': {}, '../Bridges/DMPWorkerModuleManager': {},
    '../EventTrack/DMPLogger': { DMPLogger: noLog }, '../EventTrack/Tags': { Tags: {} },
    './DMPJSEngine': { DMPJSEngine: class { initWithWorker(owner, callback) { invoke = callback } destroy() {} } },
    '../Utils/DMPMap': { DMPMap }, '../Utils/DMPContextUtils': { DMPWorkerContext: { sharedInstance: () => ({}) } },
    '../Bundle/Util/DMPRawFileUtils': {},
    '../Bundle/Util/DMPFileUrlConvertor': { DMPVirtualFileConfig: { configure() {} } }, './DMPSendableObjects': messages,
  }, { setTimeout: callback => { const id = ++timerId; timers.set(id, callback); return id }, clearTimeout: id => timers.delete(id) })
  return { port, posted, timers, init: () => port.onmessage({ data: { command: 'init', appIndex: 7 } }),
    query: body => invoke(1, 0, JSON.stringify({ type: 'canvasNodeSync', target: 'container', body })) }
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
  const posted = [], timers = new Map(), calls = []
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
    '../DApp/DMPAppManager': { DMPAppManager: { sharedInstance: () => ({ getApp: () => ({ render: { canvasNodeSync: async body => { calls.push(body.toJSON()); return '{"queries":{"location":2}}' } } }) }) } },
    '../Utils/DMPMap': { DMPMap }, '../DApp/DMPApp': {}, '../EventTrack/DMPLogger': { DMPLogger: noLog },
    '../EventTrack/Tags': { Tags: {} }, './DMPChannelProxyNext': {}, './DMPSendableObjects': messages,
    './DMPWorkerCaller': { DMPWorkerCaller: class {} }, './DMPWorkerFlushBarrier': barrier,
    '@ohos.app.ability.common': {}, '../Utils/DMPContextUtils': {}, '../Bundle/Util/DMPFileUrlConvertor': {},
  }, { setTimeout: callback => { const id = ++timerId; timers.set(id, callback); return id }, clearTimeout: id => timers.delete(id) })
  return { wrapper: new DMPWorkerWrapper(7), posted, calls, timers, terminated: () => terminated }
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
