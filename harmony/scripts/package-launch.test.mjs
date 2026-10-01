// Exercise production ArkTS loader/app methods with filesystem and platform services replaced.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import vm from 'node:vm'
const require = createRequire(new URL('../../fe/packages/compiler/package.json', import.meta.url))
const { transformSync } = require('esbuild')
const root = new URL('../dimina/src/main/ets/', import.meta.url)
function load(file, dependencies = {}) {
  const override = process.env.LAUNCH_SOURCE_ROOT
  const path = override && ['DApp/DMPApp.ets', 'Bundle/Loader/DMPReleaseBundleLoader.ets'].includes(file)
    ? `${override}/${file}` : new URL(file, root)
  const { code } = transformSync(fs.readFileSync(path, 'utf8'), { loader: 'ts', format: 'cjs' })
  const module = { exports: {} }
  vm.runInNewContext(code, { module, exports: module.exports, require: name => dependencies[name] ?? {} })
  return module.exports
}
const logger = { i() {}, d() {}, e() {} }
const context = { debugMode: false, init() {}, getUIAbilityContext() { return {} } }
const { EngineStatus, StatusMonitor } = load('DApp/utils/DMPStatusMonitor.ets')
function loaderFixture({ debug = true, hostDebug = false, appConfig = { versionCode: 7 }, sdkConfig = { versionCode: 50 },
  localAppConfig = null, localSdkConfig = null } = {}) {
  const disk = { appConfig, sdkConfig }
  const calls = { cleanup: 0, ready: 0, errors: [], install: 0, copyApp: 0, copySdk: 0, localReads: 0 }
  const preferences = new Map()
  const hostBundle = { versionCode: 1, versionName: '1' }
  const files = {
    initRootDir() {},
    loadJSAppConfig: () => disk.appConfig && {
      config: disk.appConfig, getBoolean: key => Boolean(disk.appConfig[key]),
    },
    loadJSSdkConfig: () => disk.sdkConfig,
    async copyJSAppAndUnZip() { calls.copyApp++; disk.appConfig = { ...localAppConfig } },
    async copyJSSDKAndUnZip() { calls.copySdk++; disk.sdkConfig = { ...localSdkConfig } },
    async clearJSAppHistoryBundle() { calls.cleanup++ }, async clearJSSdkHistoryBundle() { calls.cleanup++ },
  }
  const configParser = { fromJson: x => x?.config ?? x }
  const { DMPBundleLoadInfo } = load('Bundle/Model/DMPBundleLoadInfo.ets')
  const remote = {
    async installInitialPackageIfNeeded() { calls.install++; return false },
    getAppVersionInfo: () => disk.appConfig,
  }
  const { DMPReleaseBundleLoader } = load('Bundle/Loader/DMPReleaseBundleLoader.ets', {
    '../Model/DMPBundleLoadInfo': { DMPBundleLoadInfo },
    '../Util/DMPFileManager': { DMPFileManager: { sharedInstance: () => files } },
    '../Model/DMJSAppBundleConfig': { DMJSAppBundleConfig: configParser },
    '../Model/DMPJSSdkBundleConfig': { DMPJSSdkBundleConfig: configParser },
    '../../Utils/DMPContextUtils': { DMPContextUtils: { ...context, debugMode: hostDebug } },
    '../../Utils/DMPRawFileUtils': { DMPRawFileUtils: { loadFile: (_context, path) => {
      calls.localReads++
      const config = path.startsWith('jsapp/') ? localAppConfig : localSdkConfig
      return config ? JSON.stringify(config) : ''
    } } },
    '../../Utils/DMPMap': { DMPMap: { createFromString: JSON.parse } },
    '../../Utils/DMPStringUtils': { DMPStringUtils: { isNotEmpty: Boolean } },
    '../../EventTrack/DMPLogger': { DMPLogger: logger }, '../../EventTrack/Tags': { Tags: {} },
    '../../Utils/DMPPreference': { DMPPreference: { getInstance: () => ({
      get: async (key, fallback) => preferences.get(key) ?? fallback,
      put: (key, value) => preferences.set(key, value),
    }) } },
    '../Model/DMPBundleError': { ErrorCode: { LAUNCH_FAILED: 1, LOAD_LOCAL_BUNDLE_FAILED: 2 } },
    '../DMPRemoteUpdateManager': { DMPRemoteUpdateManager: { sharedInstance: () => remote } },
    '@ohos.bundle.bundleManager': { BundleFlag: {}, getBundleInfoForSelf: async () => hostBundle },
  })
  const app = { appConfig: { isDebugMode: debug } }
  const make = () => new DMPReleaseBundleLoader(app)
  const install = loader => loader.install({ appId: 'remote-app', appIndex: 1 }, info => {
    calls.ready++
    assert.equal(info.currentJsAppBundleConfig.versionCode, disk.appConfig.versionCode)
    assert.equal(info.currentJsSdkBundleConfig.versionCode, disk.sdkConfig.versionCode)
  }, undefined, (code, message) => calls.errors.push({ code, message }))
  return { disk, files, calls, remote, hostBundle, make, install }
}
for (const mode of [{ debug: true }, { debug: false, hostDebug: true }, { debug: false }]) {
  test(`remote-only cached package survives reopening and cold restart ${JSON.stringify(mode)}`, async () => {
    const f = loaderFixture(mode)
    await f.install(f.make())
    await f.install(f.make())
    assert.equal(f.calls.ready, 2)
    assert.equal(f.calls.errors.length, 0)
    assert.equal(f.disk.appConfig.versionCode, 7)
  })
}
for (const mode of [{ debug: true }, { debug: false, hostDebug: true }, { debug: false }, { debug: true, hostDebug: true }]) {
  test(`bundled package stays updated after activation, reopening and host upgrade ${JSON.stringify(mode)}`, async () => {
    const f = loaderFixture({ ...mode, appConfig: null, sdkConfig: null,
      localAppConfig: { versionCode: 1 }, localSdkConfig: { versionCode: 50 } })
    await f.install(f.make())
    assert.equal(f.calls.copyApp, 1)
    assert.equal(f.calls.copySdk, 1)
    // applyUpdate has activated the downloaded manifest package on disk.
    f.disk.appConfig = { versionCode: 2 }
    for (let restart = 0; restart < 3; restart++) {
      const info = await f.install(f.make())
      assert.equal(info.currentJsAppBundleConfig.versionCode, 2)
    }
    assert.equal(f.calls.localReads, 2, 'unchanged host must not reload bundled configs')
    f.hostBundle.versionCode++
    const info = await f.install(f.make())
    assert.equal(info.currentJsAppBundleConfig.versionCode, 2)
    assert.equal(f.calls.copyApp, 1, 'older bundled app must not replace the activated remote version')
    assert.equal(f.calls.copySdk, 1, 'equal SDK version must not be reinstalled')
    assert.equal(f.calls.errors.length, 0)
  })
  for (const cachedVersion of [1, 2, 3]) {
    test(`bundled app and SDK use version comparison with cache ${cachedVersion} ${JSON.stringify(mode)}`, async () => {
      const f = loaderFixture({ ...mode, appConfig: { versionCode: cachedVersion }, sdkConfig: { versionCode: cachedVersion },
        localAppConfig: { versionCode: 2 }, localSdkConfig: { versionCode: 2 } })
      const info = await f.install(f.make())
      assert.equal(info.currentJsAppBundleConfig.versionCode, Math.max(2, cachedVersion))
      assert.equal(info.currentJsSdkBundleConfig.versionCode, Math.max(2, cachedVersion))
      assert.equal(f.calls.copyApp, cachedVersion < 2 ? 1 : 0)
      assert.equal(f.calls.copySdk, cachedVersion < 2 ? 1 : 0)
      assert.equal(f.calls.errors.length, 0)
    })
  }
}
test('host-managed package remains authoritative over a newer bundled package', async () => {
  const f = loaderFixture({ appConfig: { versionCode: 1, hostManaged: true }, localAppConfig: { versionCode: 2 } })
  const info = await f.install(f.make())
  assert.equal(info.currentJsAppBundleConfig.versionCode, 1)
  assert.equal(f.calls.copyApp, 0)
  assert.equal(f.calls.errors.length, 0)
})
test('incomplete configuration reports failure once and skips history cleanup', async () => {
  const f = loaderFixture({ sdkConfig: null })
  await f.install(f.make())
  assert.equal(f.calls.ready, 0)
  assert.equal(f.calls.errors.length, 1)
  assert.equal(f.calls.cleanup, 0)
})
test('version lookup exception reaches the loadError callback', async () => {
  const f = loaderFixture()
  const loader = f.make()
  loader.loadAppVersion = async () => { throw new Error('version lookup failed') }
  await f.install(loader)
  assert.equal(f.calls.errors.length, 1)
  assert.equal(f.calls.cleanup, 0)
})
test('successful first manifest installation reloads config from disk', async () => {
  const f = loaderFixture({ appConfig: null })
  f.remote.installInitialPackageIfNeeded = async () => { f.disk.appConfig = { versionCode: 9 }; return true }
  await f.install(f.make())
  assert.equal(f.calls.ready, 1)
  assert.equal(f.calls.errors.length, 0)
})
test('failed manifest installation can retry on the same loader without deleting cached packages', async () => {
  const f = loaderFixture()
  const loader = f.make()
  f.remote.installInitialPackageIfNeeded = async () => { throw new Error('download failed') }
  await f.install(loader)
  assert.equal(f.calls.errors.length, 1)
  assert.equal(f.calls.cleanup, 0)
  assert.equal(f.disk.appConfig.versionCode, 7)
  f.remote.installInitialPackageIfNeeded = async () => false
  await f.install(loader)
  assert.equal(f.calls.ready, 1)
  assert.equal(f.calls.errors.length, 1)
})
function appFixture() {
  const manager = { async collectRetainedApps() {}, isDestroyingAllMiniPrograms: () => false, observeMemoryPressure() {} }
  const { DMPApp } = load('DApp/DMPApp.ets', {
    './utils/DMPStatusMonitor': { EngineStatus, StatusMonitor },
    './DMPAppManager': { DMPAppManager: { sharedInstance: () => manager } },
    '../Utils/DMPContextUtils': { DMPContextUtils: context },
    '../EventTrack/DMPLogger': { DMPLogger: logger }, '../EventTrack/Tags': { Tags: {} },
    '../Bundle/Util/DMPFileManager': { DMPFileManager: { sharedInstance: () => ({ createLocalBundleDirectoryForApp() {} }) } },
    '../Bundle/Model/DMPBundleInstallConfig': { DMPBundleInstallConfig: class {} },
    '../Bundle/DMPRemoteUpdateManager': { DMPRemoteUpdateManager: { sharedInstance: () => ({ isPackageOperationInProgress: () => false }) } },
  })
  const app = Object.create(DMPApp.prototype)
  Object.assign(app, { _runtimeGeneration: 1, _engineStatus: new StatusMonitor(), appConfig: { appId: 'remote' }, restoreRuntimeIfDestroyed() {}, _bundleManager: {} })
  return app
}
test('loadError settles separate launch waiters and late launch, then permits retry', async () => {
  const app = appFixture(), results = []
  let installs = 0, launches = 0
  app.launchInner = () => launches++
  app._bundleManager.install = async (_config, _ready, _complete, error) => { installs++; error(1, 'incomplete') }
  app.launchWhenRuntimeReady({ completion: result => results.push(result) })
  await app.startPackageLoader({})
  app.launchWhenRuntimeReady({ completion: result => results.push(result) })
  assert.deepEqual(results, [false, false])
  assert.equal(app.engineStatus.currentStatus, EngineStatus.STOP)
  app._bundleManager.install = async () => { installs++; app.engineStatus.setStatus(EngineStatus.RUN) }
  const retry = app.startPackageLoader({})
  app.launchWhenRuntimeReady({})
  await retry
  assert.equal(installs, 2)
  assert.equal(launches, 1)
})
test('installer rejection settles completion exactly once and clears waiters', async () => {
  const app = appFixture(), results = []
  const config = { completion: result => results.push(result) }
  app._bundleManager.install = async () => { throw new Error('installer failure') }
  app.launchWhenRuntimeReady(config)
  await app.startPackageLoader({}, config)
  app.engineStatus.setStatus(EngineStatus.RUN)
  assert.deepEqual(results, [false])
  assert.equal(app._engineStatus.statusListeners.size, 0)
})
