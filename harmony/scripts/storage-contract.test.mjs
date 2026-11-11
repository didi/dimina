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
  const records = new Map()
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
    storageRecordKeys: () => [...records.keys()],
    readStorageRecord: key => records.get(key),
    writeStorageRecord: (key, record) => { records.set(key, record); return true },
    clearStorageSpace: () => { values.clear(); records.clear() },
  }
  const space = load('Bundle/Util/DMPStorageSpace.ets', {})
  const { DMPContainerBridgesModuleStorage } = load('Bridges/DMPContainerBridgesModule+Storage.ets', {
    './DMPContainerBridgesModule': base, '../Utils/DMPMap': { DMPMap },
    '../Bundle/Util/DMPStorageSpace': space,
    '../Bundle/Util/DMPMMKVManager': { DMPMMKVManager: { sharedInstance: appId => {
      assert.equal(appId, 'storage-regression')
      return manager
    } } },
  })
  const bridge = new DMPContainerBridgesModuleStorage({ appId: 'storage-regression' })
  const calls = []
  return { bridge, values, records, DMPMap, calls, callback: (result, type) => calls.push({ result, type }) }
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

test('synchronous clear returns void rather than an implementation Boolean', () => {
  const f = fixture(new Map([['stored', 1]]))
  assert.equal(f.bridge.clearStorageSync(new f.DMPMap(), f.callback), undefined)
  assert.equal(f.values.size, 0)
})

test('storage info reports kilobytes and rounds a partial kilobyte up', () => {
  const f = fixture(new Map([['stored', 'x'.repeat(1025)]]), 1024 * 1024)
  const info = f.bridge.getStorageInfoSync(new f.DMPMap(), f.callback)
  assert.equal(info.get('currentSize'), 2)
  assert.equal(info.get('limitSize'), 10240)
  assert.deepEqual(Array.from(info.get('keys')), ['stored'])
  f.bridge.getStorageInfo(new f.DMPMap(), f.callback)
  assert.deepEqual(f.calls.map(x => x.type), ['success', 'complete'])
  assert.equal(f.calls[0].result.get('currentSize'), 2)
})

function wire(key, value) {
  const dataType = Object.prototype.toString.call(value).slice(8, -1)
  const data = ['Object', 'Array'].includes(dataType) ? JSON.stringify(value) : String(value)
  return { data, dataType, entrySize: JSON.stringify(key).length + 1 + JSON.stringify({ data, dataType }).length }
}

test('typed wire survives storage and ignores a forged entrySize', () => {
  const f = fixture()
  const record = { data: '1730000000000', dataType: 'Date', entrySize: 0 }
  const value = new f.DMPMap(['date', 'legacy-value', { __diminaStorageWire: record }])
  assert.equal(f.bridge.setStorageSync(value, f.callback), undefined)
  const stored = JSON.parse(f.records.get('date'))
  assert.equal(stored.wire.entrySize, JSON.stringify('date').length + 1 + JSON.stringify({ data: record.data, dataType: record.dataType }).length)
  const result = f.bridge.getStorageSync(new f.DMPMap({ key: 'date', __diminaStorageWire: true }), f.callback)
  assert.equal(result.__diminaStorageResult, 1)
  assert.equal(result.record.dataType, 'Date')
  assert.equal(f.bridge.getStorageSync('date', f.callback), 'legacy-value')
})

test('quota rejects oversized overwrite before changing the original record', () => {
  const f = fixture()
  const exact = 'x'.repeat(10 * 1024 * 1024 - 43)
  const put = value => f.bridge.setStorageSync(new f.DMPMap(['x', value, { __diminaStorageWire: wire('x', value) }]), f.callback)
  assert.equal(put(exact), undefined)
  assert.equal(f.bridge.getStorageInfoSync(new f.DMPMap(), f.callback).get('currentSize'), 10240)
  const error = put(exact + '!')
  assert.equal(error.__diminaStorageError, 'exceed storage max size 10Mb')
  assert.equal(f.bridge.getStorageSync('x', f.callback), exact)
  assert.equal(put('small'), undefined)
  assert.equal(f.bridge.getStorageInfoSync(new f.DMPMap(), f.callback).get('currentSize'), 1)
})

test('async quota failure completes with the same error and preserves legacy state', () => {
  const f = fixture(new Map([['legacy', false]]))
  const data = 'x'.repeat(10 * 1024 * 1024)
  f.bridge.setStorage(new f.DMPMap({ key: 'legacy', data, __diminaStorageWire: { ...wire('legacy', data), entrySize: 0 } }), f.callback)
  assert.deepEqual(f.calls.map(call => call.type), ['fail', 'complete'])
  assert.equal(f.calls[0].result.get('errMsg'), 'setStorage:fail exceed storage max size 10Mb')
  assert.equal(f.bridge.getStorageSync('legacy', f.callback), false)
})

test('remove and clear return void, hide legacy values and reset precise usage', () => {
  const f = fixture(new Map([['legacy', 1]]), 2 ** 20)
  assert.equal(f.bridge.removeStorageSync('legacy', f.callback), undefined)
  assert.equal(f.bridge.getStorageSync('legacy', f.callback), '')
  assert.deepEqual(Array.from(f.bridge.getStorageInfoSync(new f.DMPMap(), f.callback).get('keys')), [])
  assert.equal(f.bridge.getStorageInfoSync(new f.DMPMap(), f.callback).get('currentSize'), 1)
  assert.equal(f.bridge.clearStorageSync(new f.DMPMap(), f.callback), undefined)
  assert.equal(f.values.size, 0)
  assert.equal(f.records.size, 0)
})

test('real MMKV manager keeps logical records separate, persistent and app-scoped', () => {
  const databases = new Map()
  function store(id) {
    if (!databases.has(id)) databases.set(id, new Map())
    const values = databases.get(id)
    return {
      encodeString: (key, value) => { values.set(key, value); return true },
      encodeBool: (key, value) => { values.set(key, value); return true },
      encodeDouble: (key, value) => { values.set(key, value); return true },
      decodeString: (key, fallback) => values.get(key) ?? fallback,
      decodeBool: key => values.get(key), decodeDouble: key => values.get(key),
      allKeys: () => [...values.keys()], removeValueForKey: key => values.delete(key),
      clearAll: () => values.clear(), close() {},
    }
  }
  const { DMPMap } = load('Utils/DMPMap.ts', { '@kit.ArkTS': { ArrayList: class {} } })
  const manager = load('Bundle/Util/DMPMMKVManager.ets', {
    '@tencent/mmkv': { MMKV: {
      initializeWithPath() {}, backedUpMMKVWithID: id => store(id), SINGLE_PROCESS_MODE: 1,
      removeStorage: id => databases.delete(id),
    } },
    '@ohos.file.fs': { accessSync: () => false }, '../../Utils/DMPMap': { DMPMap },
    './DMPFileManager': { DMPFileManager: { sharedInstance: () => ({ sandboxPath: '/unused', cacheDir: '/unused' }) } },
  })
  const { DMPStorageSpace } = load('Bundle/Util/DMPStorageSpace.ets', {})
  const first = manager.DMPMMKVManager.sharedInstance('first')
  const second = manager.DMPMMKVManager.sharedInstance('second')
  assert.equal(first.encode('legacy', false), true)
  const a = new DMPStorageSpace(first), b = new DMPStorageSpace(second)
  assert.equal(a.get('legacy', false), false)
  assert.equal(a.set('record_mMKv7Yp3', 'new', wire('record_mMKv7Yp3', 'new')), true)
  assert.equal(b.set('record_mMKv7Yp3', 'other', wire('record_mMKv7Yp3', 'other')), true)
  assert.equal(a.get('record_mMKv7Yp3', true).record.data, 'new')
  assert.equal(b.get('record_mMKv7Yp3', false), 'other')
  assert.equal(databases.size, 4)
  assert.equal(first.keys().includes('record_mMKv7Yp3'), false)
  assert.equal(new DMPStorageSpace(first).get('record_mMKv7Yp3', false), 'new')
  manager.DMPMMKVManager.clearStorage('first')
  assert.equal(databases.size, 2)
  assert.equal(b.get('record_mMKv7Yp3', false), 'other')
})
