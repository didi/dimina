// Exercises the real Harmony bridge and navigator without an ArkUI device.
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
const { DMPMap } = load('Utils/DMPMap.ts', { '@kit.ArkTS': { ArrayList: class {} } })
const log = { DMPLogger: { d() {}, i() {}, e() {} } }
const base = load('Bridges/DMPContainerBridgesModule.ets', {
  '../Utils/DMPMap': { DMPMap }, '../Service/DMPSendableObjects': { AppData: class {} },
  './DMPTSUtil': { isMainThread: () => true, DMPBridgeCallbackType: { Success: 'success', Fail: 'fail', Complete: 'complete' } },
  '../EventTrack/DMPLogger': log, '../Bundle/Util/DMPFileUrlConvertor': {},
})
const { DMPContainerBridgesModuleNavigator } = load('Bridges/DMPContainerBridgesModule+Navigator.ets', {
  './DMPContainerBridgesModule': base, '../Utils/DMPMap': { DMPMap },
  '../EventTrack/DMPLogger': log, '../EventTrack/Tags': { Tags: {} },
  '../DApp/config/DMPAppConfig': { DMPLaunchType: {} },
  '../Bundle/Util/DMPFileManager': {}, '../Utils/DataTransformer': {},
  '../Service/DMPJavaScriptSourceURL': {},
})
function fixture(counts, action) {
  const requests = []
  const navigators = counts.map(count => ({
    count, getPageCount() { return this.count },
    async navigateBack(delta) {
      requests.push(delta)
      if (action) await action()
      this.count -= delta
      if (!this.count) navigators.pop()
    },
  }))
  const manager = {
    getCurNavigator: () => navigators.at(-1),
    navigationPageCount: () => navigators.reduce((n, navigator) => n + navigator.count, 0),
  }
  const bridge = new DMPContainerBridgesModuleNavigator({ navigatorManager: manager })
  const calls = []
  return { bridge, manager, requests, calls, callback: (result, type) => calls.push({ result, type }) }
}
test('first page fails without popping or hiding its navigator', async () => {
  const f = fixture([1])
  await f.bridge.navigateBack(new DMPMap(), f.callback)
  assert.deepEqual(f.requests, [])
  assert.deepEqual(f.calls.map(x => x.type), ['fail', 'complete'])
  assert.equal(f.calls[0].result.get('errMsg'), 'navigateBack:fail cannot navigate back at first page.')
  assert.equal(f.calls[1].result.get('errMsg'), f.calls[0].result.get('errMsg'))
})
test('oversized delta retains the root page', async () => {
  const f = fixture([3])
  await f.bridge.navigateBack(new DMPMap({ delta: 99 }), f.callback)
  assert.deepEqual(f.requests, [2])
  assert.equal(f.manager.navigationPageCount(), 1)
})
test('delta can traverse multiple app-owned navigators while retaining the app root', async () => {
  const f = fixture([2, 2])
  await f.bridge.navigateBack(new DMPMap({ delta: 3 }), f.callback)
  assert.deepEqual(f.requests, [2, 1])
  assert.equal(f.manager.navigationPageCount(), 1)
})
for (const [delta, expected] of [['2', 1], [0, 1], [-2, 1], [2.9, 2]]) {
  test('normalizes delta ' + JSON.stringify(delta), async () => {
    const f = fixture([4])
    await f.bridge.navigateBack(new DMPMap({ delta }), f.callback)
    assert.deepEqual(f.requests, [expected])
  })
}
test('success and complete wait for native navigation to settle', async () => {
  let finish
  const f = fixture([2], () => new Promise(resolve => { finish = resolve }))
  const pending = f.bridge.navigateBack(new DMPMap(), f.callback)
  assert.deepEqual(f.calls, [])
  finish()
  await pending
  assert.deepEqual(f.calls.map(x => x.type), ['success', 'complete'])
  assert.equal(f.calls[0].result.get('errMsg'), 'navigateBack:ok')
})
test('a rejected native operation reports fail and complete', async () => {
  const f = fixture([2], async () => { throw new Error('navigateBack:fail router unavailable') })
  await f.bridge.navigateBack(new DMPMap(), f.callback)
  assert.deepEqual(f.calls.map(x => x.type), ['fail', 'complete'])
  assert.equal(f.calls[0].result.get('errMsg'), 'navigateBack:fail router unavailable')
})

function nativeNavigatorFixture({ busy = false, routerFailure = false } = {}) {
  const { DMPStack } = load('Utils/DMPStack.ets', {})
  const { DMPNavigator } = load('Navigator/DMPNavigator.ets', {
    './DMPPageRecord': { DMPPageRecord: { shouldPopRouter: value => value !== false } },
    '../DApp/config/DMPLaunchConfig': { DMPOpenType: {} },
    '../EventTrack/DMPLogger': log, '../EventTrack/Tags': { Tags: {} },
    '../DPages/DMPPageStyle': {}, '../Utils/DMPMap': { DMPMap },
    '../DPages/DMPPageLifecycle': { DMPPageLifecycle: class { onUnload() {} onShow() {} onHide() {} } },
    '../Bridges/DMPTSUtil': { DMPBridgeCallbackType: {}, DMPTSUtil: {} },
    '@kit.ArkUI': { promptAction: {} }, '../Utils/DMPStack': { DMPStack },
    './DRouter': { DRouter: { getInstance: () => ({ pop() { if (routerFailure) throw new Error('router unavailable') } }) } },
    '../DPages/DMPPage': {}, './DMPPageStateTeardown': {},
  })
  const app = {
    currentWebViewId: 2, container: { isNavigating: busy }, appConfig: { isKeepAlive: true },
    navigatorManager: {
      isRetainedInBackground: false, popGlobalPageRecord() {}, popNavigator() {},
      notifyPopListener() {}, getActivePageRecord: () => ({ webViewId: 1 }),
    },
  }
  const navigator = new DMPNavigator(app)
  navigator.stacks.push({ webViewId: 1, ownsRouterEntry: true })
  navigator.stacks.push({ webViewId: 2, ownsRouterEntry: true })
  return navigator
}
test('real navigator propagates a native router rejection to its API caller', async () => {
  const navigator = nativeNavigatorFixture({ routerFailure: true })
  await assert.rejects(navigator.navigateBack(1), /router unavailable/)
})
test('real navigator rejects a busy page navigation instead of claiming success', async () => {
  const navigator = nativeNavigatorFixture({ busy: true })
  await assert.rejects(navigator.navigateBack(1), /navigation is in progress/)
})
test('internal relaunch preserves the existing busy-pop behavior', async () => {
  const navigator = nativeNavigatorFixture({ busy: true })
  await navigator.navigateBack(1, false, false, true)
  assert.equal(navigator.pageCount(), 2)
})

test('a native error without an API prefix gets a navigateBack failure message', async () => {
  const f = fixture([2], async () => { throw new Error('router unavailable') })
  await f.bridge.navigateBack(new DMPMap(), f.callback)
  assert.deepEqual(f.calls.map(x => x.type), ['fail', 'complete'])
  assert.equal(f.calls[0].result.get('errMsg'), 'navigateBack:fail router unavailable')
})
