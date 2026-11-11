// Storage contracts from the bundled WeChat appservice handler; no device storage.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
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
    assert.ok(name in dependencies, 'Unexpected dependency: ' + name)
    return dependencies[name]
  } })
  return module.exports
}

function fixture(values = new Map(), byteSize = 0) {
  const { DMPMap } = load('Utils/DMPMap.ts', { '@kit.ArkTS': { ArrayList: class {} } })
  const types = { Success: 'success', Fail: 'fail', Complete: 'complete' }
  const base = load('Bridges/DMPContainerBridgesModule.ets', {
    '../DApp/DMPApp': {}, '../Utils/DMPMap': { DMPMap },
    '../Service/DMPSendableObjects': {},
    './DMPTSUtil': { DMPBridgeCallbackType: types, isMainThread: () => false },
    '../EventTrack/DMPLogger': { DMPLogger: { d() {} } },
    '../Bundle/Util/DMPFileUrlConvertor': {},
  })
  const manager = {
    decode: key => new DMPMap({ value: values.has(key) ? values.get(key) : '', type: values.has(key) ? typeof values.get(key) : '' }),
    clear: () => values.clear(), totalSize: () => byteSize, keys: () => [...values.keys()],
  }
  const { DMPContainerBridgesModuleStorage } = load('Bridges/DMPContainerBridgesModule+Storage.ets', {
    './DMPContainerBridgesModule': base, '../Utils/DMPMap': { DMPMap },
    '../Bundle/Util/DMPMMKVManager': { DMPMMKVManager: { sharedInstance: appId => {
      assert.equal(appId, 'storage-regression')
      return manager
    } } },
  })
  const bridge = new DMPContainerBridgesModuleStorage({ appId: 'storage-regression' })
  const calls = []
  return { bridge, values, DMPMap, calls, callback: (result, type) => calls.push({ result, type }) }
}

test('getStorage rejects missing keys and completes with the same failure', () => {
  const f = fixture()
  f.bridge.getStorage(new f.DMPMap({ key: 'missing' }), f.callback)
  assert.deepEqual(f.calls.map(x => x.type), ['fail', 'complete'])
  assert.equal(f.calls[0].result.get('errMsg'), 'getStorage:fail data not found')
  assert.equal(f.calls[1].result.get('errMsg'), f.calls[0].result.get('errMsg'))
})

for (const value of [false, 0, '', null]) {
  test('getStorage preserves a stored ' + JSON.stringify(value), () => {
    const f = fixture(new Map([['stored', value]]))
    f.bridge.getStorage(new f.DMPMap({ key: 'stored' }), f.callback)
    assert.deepEqual(f.calls.map(x => x.type), ['success', 'complete'])
    assert.equal(f.calls[0].result.get('data'), value)
  })
}

test('clearStorage clears values and resolves success and complete', () => {
  const f = fixture(new Map([['stored', 1]]))
  f.bridge.clearStorage(new f.DMPMap(), f.callback)
  assert.equal(f.values.size, 0)
  assert.deepEqual(f.calls.map(x => x.type), ['success', 'complete'])
  assert.equal(f.calls[0].result.get('errMsg'), 'clearStorage:ok')
  assert.equal(f.calls[1].result.get('errMsg'), 'clearStorage:ok')
})

test('storage info reports kilobytes and rounds a partial kilobyte up', () => {
  const f = fixture(new Map([['stored', 1]]), 1025)
  const info = f.bridge.getStorageInfoSync(new f.DMPMap(), f.callback)
  assert.equal(info.get('currentSize'), 2)
  assert.equal(info.get('limitSize'), 10240)
  assert.deepEqual(Array.from(info.get('keys')), ['stored'])
  f.bridge.getStorageInfo(new f.DMPMap(), f.callback)
  assert.deepEqual(f.calls.map(x => x.type), ['success', 'complete'])
  assert.equal(f.calls[0].result.get('currentSize'), 2)
})
