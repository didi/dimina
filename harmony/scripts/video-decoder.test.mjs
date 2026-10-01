// Execute the production ArkTS bridge with a mocked N-API backend; this is not a device codec test.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import vm from 'node:vm'

const require = createRequire(new URL('../../fe/packages/compiler/package.json', import.meta.url))
const { transformSync } = require('esbuild')
const root = new URL('../dimina/src/main/ets/', import.meta.url)
function load(path, dependencies) {
  const { code } = transformSync(fs.readFileSync(new URL(path, root), 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022' })
  const module = { exports: {} }
  vm.runInNewContext(code, { module, exports: module.exports, Uint8Array, require: name => {
    assert.ok(name in dependencies, `Unexpected dependency: ${name}`)
    return dependencies[name]
  } })
  return module.exports
}
function fixture() {
  const calls = [], results = []
  let frame = { width: 1, height: 1, pts: 20, data: Uint8Array.of(1, 2, 3, 255).buffer }
  const { DMPMap } = load('Utils/DMPMap.ts', { '@kit.ArkTS': { ArrayList: class {} } })
  class Base {
    constructor(app) { this.appData = app }
    currentAppId() { return this.appData.appId }
    invokeSuccessCallback(callback, result) { results.push(['success', result.toJSON()]) }
    invokeFailureCallback(callback, param, message) { results.push(['fail', message]) }
  }
  const native = {
    videoDecoderOperate: async (...args) => { calls.push(args); return { width: 1, height: 1 } },
    videoDecoderGetFrame: (...args) => { calls.push(['frame', ...args]); return frame },
    videoDecoderDispose: owner => calls.push(['dispose', owner]),
  }
  const { DMPContainerBridgesModuleVideoDecoder } = load('Bridges/DMPContainerBridgesModule+VideoDecoder.ets', {
    '@kit.ArkTS': { util: { Base64Helper: class { encodeToStringSync(bytes) { return Buffer.from(bytes).toString('base64') } } } },
    'libdimina.so': native,
    './DMPContainerBridgesModule': { DMPContainerBridgesModule: Base },
    '../Utils/DMPMap': { DMPMap },
    '../Bundle/Util/DMPFileManager': { DMPFileManager: { sharedInstance: () => ({ getJSAppVersionDir: (id, version) => `/packages/${id}/${version}` }) } },
    '../Bundle/Util/DMPFilePathResolver': { DMPFilePathResolver: { resolve: (path, id, root) => {
      if (path.includes('..')) throw new Error('permission denied')
      if (path.startsWith('/')) throw new Error('permission denied')
      return `${root}/${path}`
    } } },
  })
  const bridge = new DMPContainerBridgesModuleVideoDecoder({ appIndex: 7, appId: 'owner', jsAppVersion: 'v1' })
  return { bridge, calls, results, native, setFrame: value => { frame = value },
    run: (command, params = {}) => bridge.dispatchVideoDecoder(`VideoDecoder.${command}`, new DMPMap({ decoderId: 'decoder', ...params }), () => {}) }
}

test('resolves package paths with the active app version and forwards millisecond seek', async () => {
  const f = fixture()
  f.run('start', { source: '/assets/video.mp4' })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(f.calls[0], [7, 'decoder', 'start', '/packages/owner/v1/assets/video.mp4', 1])
  assert.equal(f.results[0][1].errMsg, 'VideoDecoder.start:ok')
  f.run('seek', { position: 125 })
  assert.deepEqual(f.calls[1], [7, 'decoder', 'seek', '', 125])
})

test('returns synchronous RGBA frames using the service ArrayBuffer wire contract', () => {
  const f = fixture()
  const result = f.run('getFrameData')
  assert.equal(result.get('data').__diminaArrayBufferBase64, 'AQID/w==')
  assert.equal(result.get('pts'), 20)
  assert.deepEqual(f.calls[0], ['frame', 7, 'decoder'])
  f.setFrame({ ended: true })
  assert.equal(f.run('getFrameData').get('ended'), true)
})

test('rejects path escapes and forwards native control and decode errors', async () => {
  const f = fixture()
  f.run('start', { source: '../other/video.mp4' })
  assert.equal(f.calls.length, 0)
  assert.match(f.results[0][1], /permission denied/)
  f.native.videoDecoderOperate = async () => { throw new Error('unsupported codec') }
  f.run('start', { source: 'https://example.com/video.mp4' })
  await new Promise(resolve => setImmediate(resolve))
  assert.match(f.results[1][1], /unsupported codec/)
  f.setFrame({ error: 'decode failed' })
  assert.equal(f.run('getFrameData').get('error'), 'decode failed')
})

test('disposes only this app generation and suppresses late callbacks', async () => {
  const f = fixture()
  f.run('start', { source: 'video.mp4' })
  f.bridge.dispose()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(f.calls.at(-1), ['dispose', 7])
  assert.equal(f.results.length, 0)
  assert.match(f.run('getFrameData').get('error'), /disposed/)
})

test('worker dispatch uses its own registry for capability checks', async () => {
  let invoke
  const port = { callGlobalCallObjectMethod: () => false }
  const noLog = { d() {}, e() {} }
  load('Service/DMPWorker.ets', {
    '@kit.ArkTS': { worker: { workerPort: port } },
    '../Bridges/DMPTSUtil': {},
    '../Bridges/DMPWorkerModuleManager': { DMPWorkerModuleManager: class {
      getModuleObjectByMethodNameAndModuleName(name) { return name === 'VideoDecoder.start' ? {} : null }
    } },
    '../EventTrack/DMPLogger': { DMPLogger: noLog },
    '../EventTrack/Tags': { Tags: {} },
    './DMPJSEngine': { DMPJSEngine: class { initWithWorker(owner, callback) { invoke = callback } } },
    '../Utils/DMPMap': {},
    '../Utils/DMPContextUtils': { DMPWorkerContext: { sharedInstance: () => ({}) } },
    '../Bundle/Util/DMPFileUrlConvertor': { DMPVirtualFileConfig: { configure() {} } },
    './DMPSendableObjects': {},
  })
  await port.onmessage({ data: { command: 'init', appIndex: 7 } })
  await port.onmessage({ data: { command: 'updateWorkerAppData', payload: { appData: {} } } })
  const query = name => invoke(1, 0, JSON.stringify({ type: 'invokeAPI', target: 'container', body: { name: 'canIUse', params: name } }))
  assert.equal(query('VideoDecoder.start'), true)
  assert.equal(query('unsupportedAPI'), false)
})
