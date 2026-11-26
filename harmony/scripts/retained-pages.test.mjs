// Run with `node --test harmony/scripts/retained-pages.test.mjs` after installing fe dependencies.
// Exercise ArkTS navigation bookkeeping on Node; HAR/device checks cover ArkUI itself.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import vm from 'node:vm'

const require = createRequire(new URL('../../fe/packages/compiler/package.json', import.meta.url))
const { transformSync } = require('esbuild')
const sourceRoot = new URL('../dimina/src/main/ets/', import.meta.url)

function load(name, dependencies = {}, clock = {}, { mockUnusedImports = false } = {}) {
  const source = fs.readFileSync(new URL(name, sourceRoot), 'utf8')
  const { code } = transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2022' })
  const module = { exports: {} }
  vm.runInNewContext(code, {
    module,
    setTimeout: (fn, ms) => setTimeout(fn, ms).unref(),
    clearTimeout,
    ...clock,
    exports: module.exports,
    require: name => {
      assert.ok(mockUnusedImports || name in dependencies, `Unexpected runtime dependency: ${name}`)
      return dependencies[name] ?? {}
    },
  })
  return module.exports
}

const teardown = load('Navigator/DMPPageStateTeardown.ets')

function fixture() {
  const popped = []
  const pushed = []
  const disposed = []
  const router = {
    popEntries: count => popped.push(count),
    build: name => {
      const route = { name, extras: {} }
      const request = {
        putExtra(key, value) { route.extras[key] = value; return request },
        setNavMode() { return request },
        start() { pushed.push(route) },
      }
      return request
    },
  }
  const { DMPNavigatorManager } = load('Navigator/DMPNavigatorManager.ets', {
    '../Utils/DMPStack': load('Utils/DMPStack.ets'),
    '../EventTrack/DMPLogger': { DMPLogger: { d() {}, i() {}, e() {} } },
    '../EventTrack/Tags': { Tags: {} },
    '../DPages/DMPPageLifecycle': { DMPPageLifecycle: class {} },
    './DMPPageStateTeardown': teardown,
    './DRouter': { DRouter: { getInstance: () => router } },
  })
  const manager = new DMPNavigatorManager(null, {
    onShow() {}, onHide() {}, onUnload() { assert.fail('App exit must not dispatch pageUnload') },
  })
  const records = [1, 2].map(webViewId => ({
    appIndex: 7, webViewId, ownsRouterEntry: true, retainsNativeView: false,
    webViewNodeController: { dispose() { disposed.push(webViewId) } },
  }))
  const navigator = {
    stacks: { data: records },
    routerEntryCount: () => records.length,
    closeAllPages() { while (records.length) { records.pop(); manager.popGlobalPageRecord() } },
  }
  manager.pushNavigator({ id: 42, getNavigator: () => navigator })
  records.forEach(record => manager.pushGlobalPageRecord(record))
  return { manager, records, popped, pushed, disposed }
}

test('hide/resume retains page identities and restores ordered route ownership', () => {
  const f = fixture()
  const first = f.records[0]
  const second = f.records[1]
  for (let i = 0; i < 2; i++) {
    f.manager.hidePresentation()
    assert.equal(f.manager.isRetainedInBackground, true)
    assert.equal(f.manager.getPageRecordById(2), second)
    assert.equal(f.manager.getTopPageRecord(), second)
    assert.equal(first.retainsNativeView, true)
    assert.deepEqual(f.disposed, [])
    assert.equal(f.manager.resumePresentation(), true)
    assert.equal(f.manager.isRetainedInBackground, false)
    assert.deepEqual(f.pushed.slice(-2).map(route => route.extras), [
      { appIndex: 7, webViewId: 1, stackId: 42 },
      { appIndex: 7, webViewId: 2, stackId: 42 },
    ])
  }
})

test('destroying a retained app releases its nodes without popping the foreground app', () => {
  const f = fixture()
  f.manager.registerTabPageRecord({ webViewId: 3, webViewNodeController: { dispose: () => f.disposed.push(3) } })
  f.manager.hidePresentation()
  f.popped.length = 0
  f.manager.closeAllNavigators(teardown.DMPPageStateTeardown.Exit)
  assert.deepEqual(f.popped, [])
  assert.deepEqual(f.disposed, [2, 1, 3])
  assert.equal(f.manager.getPageRecordById(1), undefined)
  assert.equal(f.manager.isRetainedInBackground, false)
})

test('capture native tab state before detaching and make repeated hide/resume idempotent', () => {
  const f = fixture()
  let captures = 0
  f.manager.captureTabState = () => {
    assert.equal(f.popped.length, 0)
    captures++
  }
  f.manager.hidePresentation()
  f.manager.hidePresentation()
  assert.equal(captures, 1)
  assert.deepEqual(f.popped, [2])
  assert.equal(f.manager.resumePresentation(), true)
  assert.equal(f.manager.resumePresentation(), false)
  assert.equal(f.pushed.length, 2)
})

test('rejects host-managed pages before notifying hide or detaching routes', () => {
  const f = fixture()
  f.records.length = 0
  let hides = 0
  assert.throws(() => f.manager.hidePresentation(() => hides++), /host-managed pages/)
  assert.equal(hides, 0)
  assert.equal(f.manager.isRetainedInBackground, false)
  assert.deepEqual(f.popped, [])
})

function relaunchFixture() {
  const unloads = []
  const disposals = []
  const nativePops = []
  const pendingLaunches = []
  const router = {
    pop: () => nativePops.push(1),
    popEntries: count => nativePops.push(count),
  }
  class RecordingPageLifecycle {
    onShow() {}
    onHide() {}
    onUnload(id) { unloads.push(id) }
  }
  const launchConfig = load('DApp/config/DMPLaunchConfig.ets')
  const deps = {
    '../EventTrack/DMPLogger': { DMPLogger: { d() {}, i() {}, e() {} } },
    '../EventTrack/Tags': { Tags: {} },
    '../Utils/DMPStack': load('Utils/DMPStack.ets'),
    '../DPages/DMPPageLifecycle': { DMPPageLifecycle: RecordingPageLifecycle },
    './DRouter': { DRouter: { getInstance: () => router } },
    './DMPPageStateTeardown': teardown,
  }
  const { DMPNavigator } = load('Navigator/DMPNavigator.ets', {
    ...deps,
    './DMPPageRecord': { DMPPageRecord: { shouldPopRouter: owns => owns !== false } },
    '../DApp/config/DMPLaunchConfig': launchConfig,
    '../DPages/DMPPageStyle': {},
    '../Utils/DMPMap': {},
    '../Bridges/DMPTSUtil': {},
    '@kit.ArkUI': {},
    '../DPages/DMPPage': {},
  })
  const { DMPNavigatorManager } = load('Navigator/DMPNavigatorManager.ets', deps)
  // Skip unrelated DMPApp dependencies because the fixture does not construct the app.
  const { DMPApp } = load('DApp/DMPApp.ets', {
    ...deps,
    './config/DMPLaunchConfig': launchConfig,
    '../Navigator/DMPPageStateTeardown': teardown,
  }, { setTimeout: run => pendingLaunches.push(run) }, { mockUnusedImports: true })
  // Use the real route methods with no constructor-owned Worker or ArkUI view.
  const app = Object.create(DMPApp.prototype)
  app._container = { isNavigating: false }
  const manager = new DMPNavigatorManager(null, new RecordingPageLifecycle())
  app._navigatorManager = manager
  app.startMainService = async () => {}
  function record(webViewId, ownsRouterEntry = true) {
    return { webViewId, ownsRouterEntry, webViewNodeController: { dispose: () => disposals.push(webViewId) } }
  }
  function mount(records, config = { appEntryPath: 'pages/tab-a/index' }) {
    const navigator = new DMPNavigator(app)
    manager.pushNavigator({
      getNavigator: () => navigator,
      getPageCount: () => navigator.pageCount(),
      getLaunchConfig: () => config,
      navigateBack: (...args) => navigator.navigateBack(...args),
    })
    records.forEach(record => {
      navigator.stacks.push(record)
      manager.pushGlobalPageRecord(record)
    })
  }
  return { app, manager, record, mount, unloads, disposals, nativePops, pendingLaunches }
}

for (const route of ['single navigator', 'two navigators', 'host-mounted root']) {
  test(`reLaunch clears all loaded tabs before replacing the ${route}`, async () => {
    const f = relaunchFixture()
    const hostMounted = route === 'host-mounted root'
    const rootConfig = { appEntryPath: 'pages/tab-a/index', customLaunchPageCallBack: hostMounted ? () => {} : undefined }
    const root = f.record(11, !hostMounted)
    const detail = f.record(14)
    f.mount(route === 'single navigator' ? [root, detail] : [root], rootConfig)
    if (route === 'two navigators') f.mount([detail])
    f.manager.registerTabPageRecord(f.record(12))
    f.manager.registerTabPageRecord(f.record(13))
    f.manager.setCurrentTabWebViewId(12)
    f.manager.retainedTabState = { selectedIndex: 1 }

    const expected = hostMounted ? [11, 12, 13] : [14, 11, 12, 13]
    let replacementRequested = false
    f.app.launch = ({ appEntryPath }) => {
      replacementRequested = true
      assert.equal(appEntryPath, 'pages/tab-a/index')
      assert.deepEqual(f.unloads, expected)
      assert.deepEqual(f.disposals, expected)
      assert.ok(f.manager.isEmpty())
      assert.equal(f.manager.getCurrentTabWebViewId(), -1)
      assert.equal(f.manager.retainedTabState, undefined)
      expected.forEach(id => assert.equal(f.manager.getPageRecordById(id), undefined))
    }
    f.app.reLaunch()
    assert.equal(f.pendingLaunches.length, 1)
    assert.deepEqual(f.nativePops, hostMounted ? [] : [1, 1])
    await f.pendingLaunches[0]()
    assert.ok(replacementRequested)
  })
}


function appManagerFixture(clock = {}) {
  let now = 0
  const { DMPAppManager } = load('DApp/DMPAppManager.ets', {
    '../EventTrack/DMPRuntimeDiagnostics': { DMPRuntimeDiagnostics: { launch() {} } },
    '../Utils/DMPCapsuleAppearance': load('Utils/DMPCapsuleAppearance.ets'),
    './DMPMiniProgramPresentationStack': load('DApp/DMPMiniProgramPresentationStack.ets', { '../Utils/DMPMap': {} }),
    './config/DMPLaunchConfig': load('DApp/config/DMPLaunchConfig.ets'),
    './config/DMPAppConfig': {},
    '@kit.BasicServicesKit': { systemDateTime: { TimeType: { STARTUP: 0 }, getUptime: () => now } },
    './DMPApp': {},
    '../EventTrack/DMPLogger': { DMPLogger: { d() {}, i() {}, e() {} } },
    '../EventTrack/Tags': { Tags: {} },
    '../Utils/DMPContextUtils': {},
    '../Utils/DMPRawFileUtils': {},
    '../Utils/DMPMap': {},
    '../Bundle/DMPRemoteUpdateManager': {},
    '../Bundle/Util/DMPMMKVManager': {},
    '../Utils/DMPPreference': {},
  }, clock)
  const manager = new DMPAppManager()
  const storedConfig = { scene: 1037, referrerInfo: { appId: 'old-opener' }, appEntryPath: 'pages/detail' }
  const shown = []
  const app = {
    appIndex: 17, appConfig: { appId: 'retained' },
    getLaunchConfig: () => storedConfig,
    prepareHostEntry(config) { this.entryConfig = config },
    navigatorManager: { resumePresentation() {} },
    notifyMiniProgramShow: (scene, referrerInfo) => shown.push({ scene, referrerInfo }),
  }
  return { manager, app, storedConfig, shown, setNow: value => { now = value } }
}

test('host re-entry refreshes the config used by later system foreground events', () => {
  const f = appManagerFixture()
  let completed = false
  f.manager.resumeRetainedApp(f.app, { scene: 1011, completion: success => { completed = success } })
  assert.equal(completed, true)
  assert.equal(f.storedConfig.scene, 1011)
  assert.equal(f.app.entryConfig.scene, 1011)
  assert.equal(f.storedConfig.referrerInfo, undefined)
  assert.equal(f.storedConfig.appEntryPath, 'pages/detail')
  // DMPAppLifecycle reads this config again after a system background/foreground cycle.
  f.app.notifyMiniProgramShow(f.storedConfig.scene, f.storedConfig.referrerInfo)
  assert.deepEqual(f.shown, [{ scene: 1011, referrerInfo: undefined }, { scene: 1011, referrerInfo: undefined }])
  f.manager.resumeRetainedApp(f.app, {})
  assert.equal(f.storedConfig.scene, 1001)
})


test('retention evicts LRU, expires leases and preserves a pinned presentation', async () => {
  const f = appManagerFixture()
  const closed = []
  const make = index => {
    const app = { appIndex: index, navigatorManager: { isRetainedInBackground: true },
      closeDimina: async () => { closed.push(index); f.manager.appPools.delete(index) } }
    f.manager.appPools.set(index, app)
    return app
  }
  const a = make(1); const b = make(2); const c = make(3)
  f.manager.configureRetention({ maxBackgroundApps: 1, backgroundTimeoutMs: 100 })
  f.manager.retentionVisibility(a, false)
  f.setNow(10); f.manager.retentionVisibility(b, false)
  f.setNow(20); f.manager.retentionVisibility(a, false)
  c.navigatorManager.isRetainedInBackground = false
  f.manager.retentionVisibility(c, false)
  await f.manager.collectRetainedApps()
  assert.deepEqual(closed, [1])
  f.setNow(109); await f.manager.collectRetainedApps()
  assert.deepEqual(closed, [1])
  f.setNow(110); await f.manager.collectRetainedApps()
  assert.deepEqual(closed, [1, 2])
  f.manager.notifyMemoryPressure(); await f.manager.collectRetainedApps()
  assert.ok(f.manager.appPools.has(3))
  c.navigatorManager.isRetainedInBackground = true
  f.manager.notifyMemoryPressure(); await f.manager.collectRetainedApps()
  assert.deepEqual(closed, [1, 2, 3])
})


test('a failed eviction retains its lease and does not prevent reclaiming another background app', async () => {
  const f = appManagerFixture()
  let attempts = 0
  const closed = []
  const bad = { appIndex: 21, navigatorManager: { isRetainedInBackground: true },
    closeDimina: async () => {
      attempts++
      f.manager.retentionVisibility(bad, false) // performClose repeats App hide before flushing.
      await Promise.resolve()
      if (attempts === 1) throw new Error('worker close failed')
      closed.push(21); f.manager.appPools.delete(21)
    } }
  const good = { appIndex: 22, navigatorManager: { isRetainedInBackground: true },
    closeDimina: async () => { closed.push(22); f.manager.appPools.delete(22) } }
  f.manager.miniProgramOperationInProgress = true
  f.manager.configureRetention({ maxBackgroundApps: 0, backgroundTimeoutMs: 0 })
  for (const app of [bad, good]) {
    f.manager.appPools.set(app.appIndex, app)
    f.manager.retentionVisibility(app, false)
  }
  f.manager.notifyMemoryPressure()
  await Promise.resolve() // Let the scheduled collection observe the navigation lock.
  f.manager.miniProgramOperationInProgress = false
  await assert.doesNotReject(f.manager.collectRetainedApps())
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(closed, [22])
  assert.ok(f.manager.appPools.has(21))
  f.manager.notifyMemoryPressure()
  await f.manager.collectRetainedApps()
  assert.deepEqual(closed, [22, 21])
  assert.equal(attempts, 2)
})

test('an expired app that fails to close does not create an immediate retry timer', async () => {
  const pending = new Map()
  let nextTimer = 0
  const f = appManagerFixture({
    setTimeout(fn, ms) { const id = ++nextTimer; pending.set(id, { fn, ms }); return id },
    clearTimeout(id) { pending.delete(id) },
  })
  let attempts = 0
  const app = { appIndex: 31, navigatorManager: { isRetainedInBackground: true },
    closeDimina: async () => { attempts++; throw new Error('close unavailable') } }
  f.manager.miniProgramOperationInProgress = true
  f.manager.configureRetention({ maxBackgroundApps: 3, backgroundTimeoutMs: 100 })
  f.manager.appPools.set(app.appIndex, app)
  f.manager.retentionVisibility(app, false)
  await Promise.resolve()
  f.manager.miniProgramOperationInProgress = false
  f.setNow(100)
  await assert.doesNotReject(f.manager.collectRetainedApps())
  assert.equal(attempts, 1)
  assert.ok(f.manager.appPools.has(app.appIndex))
  assert.equal(pending.size, 0)
  f.manager.notifyMemoryPressure()
  await f.manager.collectRetainedApps()
  assert.equal(attempts, 2)
  assert.equal(pending.size, 0)
})


test('destroy all closes the presentation top first, includes retained apps and is repeatable', async () => {
  const { manager } = appManagerFixture()
  const closed = []
  const make = index => {
    const app = { appIndex: index, appConfig: { appId: `app-${index}` },
      closeDimina: async () => {
        assert.equal(manager.isDestroyingAllMiniPrograms(), true)
        assert.equal(manager.getPresentedApp(), undefined)
        closed.push(index)
        manager.exitApp(app.appConfig.appId, index)
      } }
    manager.appPools.set(index, app)
    return app
  }
  make(3); make(1); make(2)
  // Reused app 1 was created before its current opener 2.
  manager.miniProgramPresentations.ensureRoot(2, 'app-2')
  manager.miniProgramPresentations.push(2, 1, 'app-1')
  await manager.destroyAllMiniPrograms()
  assert.deepEqual(closed, [1, 2, 3])
  assert.equal(manager.appPools.size, 0)
  assert.equal(manager.isDestroyingAllMiniPrograms(), false)
  await manager.destroyAllMiniPrograms()
  assert.deepEqual(closed, [1, 2, 3])
  assert.equal(manager.miniProgramPresentations.ensureRoot(4, 'fresh'), true)
})

test('destroy all rejects busy operations without changing the pool', async () => {
  const { manager, app } = appManagerFixture()
  manager.appPools.set(app.appIndex, app)
  manager.miniProgramOperationInProgress = true
  await assert.rejects(manager.destroyAllMiniPrograms(), /operation is in progress/)
  assert.equal(manager.appPools.get(app.appIndex), app)
})

test('destroy all attempts remaining owners after a failure and allows retry', async () => {
  const { manager } = appManagerFixture()
  let fail = true
  const closed = []
  for (const index of [1, 2]) {
    manager.appPools.set(index, { appIndex: index, closeDimina: async () => {
      if (index === 1 && fail) throw new Error('flush failed')
      closed.push(index)
      manager.appPools.delete(index)
    } })
  }
  await assert.rejects(manager.destroyAllMiniPrograms(), /flush failed/)
  assert.deepEqual(closed, [2])
  assert.equal(manager.isDestroyingAllMiniPrograms(), false)
  fail = false
  await manager.destroyAllMiniPrograms()
  assert.deepEqual(closed, [2, 1])
  assert.equal(manager.appPools.size, 0)
})
