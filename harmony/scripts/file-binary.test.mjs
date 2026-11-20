// Production Worker routing; native N-API/QuickJS codec is tested separately.
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
  vm.runInNewContext(code, { module, exports: module.exports, Sendable: value => value, ArrayBuffer, Uint8Array,
    setTimeout, clearTimeout, require: name => {
      assert.ok(name in dependencies, `Unexpected dependency: ${name}`)
      return dependencies[name]
    } })
  return module.exports
}
test('file Worker preserves binary callbacks and exports metadata only when diagnostics is enabled', async () => {
  const { DMPMap } = load('Utils/DMPMap.ts', { '@kit.ArkTS': {} })
  const util = load('Bridges/DMPTSUtil.ts', { '../Utils/DMPMap': { DMPMap }, '@kit.ArkTS': {} })
  const messages = load('Service/DMPSendableObjects.ets', { '@kit.ArkTS': {}, '@ohos.app.ability.common': {}, '../Utils/DMPMap': { DMPMap } })
  let invoke
  const received = []
  const bytes = new Uint8Array(8 * 1024 * 1024).fill(173).buffer
  const fileModule = {
    dispatchFileSystemManager(name, params, callback) {
      assert.equal(params.get('data'), bytes)
      const result = new DMPMap({ data: bytes, errMsg: `${name}:ok` })
      callback(result, util.DMPBridgeCallbackType.Success)
      callback(result, util.DMPBridgeCallbackType.Complete)
      return undefined
    },
  }
  const diagnostics = []
  const port = {
    postMessage(event) { diagnostics.push(event) },
    callGlobalCallObjectMethod() { throw new Error('file API must stay in Worker') },
  }
  load('Service/DMPWorker.ets', {
    '@kit.BasicServicesKit': { systemDateTime: { getUptime: () => 123, TimeType: { STARTUP: 0 } } },
    '@kit.ArkTS': { worker: { workerPort: port } }, '../Bridges/DMPTSUtil': util,
    '../Bridges/DMPWorkerModuleManager': { DMPWorkerModuleManager: class {
      getModuleObjectByMethodNameAndModuleName() { return fileModule }
    } },
    '../EventTrack/DMPLogger': { DMPLogger: { d() {}, e() {} } }, '../EventTrack/Tags': { Tags: {} },
    './DMPJSEngine': { DMPJSEngine: class {
      initWithWorker(owner, callback) { invoke = callback }
      postMessage(message) { received.push(message) }
      evalJS() { throw new Error('file callbacks must not evaluate scripts') }
    } },
    '../Utils/DMPMap': { DMPMap }, './DMPSendableObjects': messages,
    '../Utils/DMPContextUtils': { DMPWorkerContext: { sharedInstance: () => ({}) } },
    '../Bundle/Util/DMPRawFileUtils': {},
    '../Bundle/Util/DMPFileUrlConvertor': { DMPVirtualFileConfig: { configure() {} } },
  })
  await port.onmessage({ data: { command: 'init', appIndex: 7 } })
  await port.onmessage({ data: { command: 'updateWorkerAppData', payload: { appData: { appIndex: 7 } } } })
  const writeFile = () => invoke(4, 0, { type: 'invokeAPI', target: 'container', body: {
    bridgeId: 9, name: 'FileSystemManager.writeFile', params: { data: bytes, success: 'success', complete: 'complete' },
  } })
  writeFile()
  assert.deepEqual(received.map(message => message.body.id), ['success', 'complete'])
  for (const message of received) assert.equal(message.body.args.data, bytes)
  assert.equal(diagnostics.length, 0)

  await port.onmessage({ data: new messages.DiagnosticCaptureRequest(8) })
  writeFile()
  assert.deepEqual(diagnostics.map(event => [event.phase, event.outcome]), [
    ['api-received', undefined], ['api-callback', 'success'], ['api-callback', 'complete'],
  ])
  assert.equal(new Set(diagnostics.map(event => event.id)).size, 1)
  for (const event of diagnostics) {
    assert.equal(event.generation, 8)
    assert.equal(event.bridgeId, '9')
    assert.equal(event.api, 'FileSystemManager.writeFile')
    assert.ok(!('args' in event) && !('data' in event) && !('params' in event))
  }
  await port.onmessage({ data: new messages.DiagnosticCaptureRequest() })
  writeFile()
  assert.equal(diagnostics.length, 3)
})
