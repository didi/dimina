import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import vm from 'node:vm'

const require = createRequire(new URL('../../fe/packages/compiler/package.json', import.meta.url))
const { transformSync } = require('esbuild')
const { code } = transformSync(fs.readFileSync(new URL('../dimina/src/main/ets/Utils/DMPCapsuleAppearance.ets', import.meta.url), 'utf8'), { loader: 'ts', format: 'cjs' })
const module = { exports: {} }
vm.runInNewContext(code, { module, exports: module.exports })
const { DMPCapsuleAppearance } = module.exports

test('default capsule follows the page foreground through both modes', () => {
  const appearance = new DMPCapsuleAppearance()
  assert.equal(appearance.iconColor(true), '#ffffff')
  assert.equal(appearance.backgroundColor(true), '#33000000')
  assert.equal(appearance.iconColor(false), '#1f1f1f')
  assert.equal(appearance.backgroundColor(false), '#ffffff')
})

test('host overrides retain their exact color and alpha in both modes', () => {
  const appearance = new DMPCapsuleAppearance()
  appearance.iconOverride = '#1f1f1f'
  appearance.backgroundOverride = '#80ffffff'
  for (const whiteForeground of [true, false]) {
    assert.equal(appearance.iconColor(whiteForeground), '#1f1f1f')
    assert.equal(appearance.backgroundColor(whiteForeground), '#80ffffff')
  }
})

test('dynamic navigation color updates the system bar only for the presented page', () => {
  const load = (relativePath, dependencies) => {
    const { code } = transformSync(fs.readFileSync(new URL(relativePath, import.meta.url), 'utf8'), {
      loader: 'ts', format: 'cjs', tsconfigRaw: { compilerOptions: { experimentalDecorators: true } }
    })
    const module = { exports: {} }
    vm.runInNewContext(code, { module, exports: module.exports, Observed: value => value, require: name => {
      assert.ok(name in dependencies, `Unexpected import: ${name}`)
      return dependencies[name]
    } })
    return module.exports
  }
  const calls = []
  let presentedApp
  const manager = { getPresentedApp: () => presentedApp, getApp: () => undefined }
  const logger = { d() {} }
  const sharedDependencies = {
    '../DApp/DMPAppManager': { DMPAppManager: { sharedInstance: () => manager } },
    '../EventTrack/DMPLogger': { DMPLogger: logger }
  }
  const { DMPPageStyle } = load('../dimina/src/main/ets/DPages/DMPPageStyle.ets', sharedDependencies)
  class BridgeModule {
    constructor(app) { this.app = app }
    invokeSuccessCallback() {}
  }
  class TestMap extends Map {
    toStr() { return JSON.stringify([...this]) }
  }
  const { DMPContainerBridgesModuleNavigationBar } = load('../dimina/src/main/ets/Bridges/DMPContainerBridgesModule+NavigationBar.ets', {
    ...sharedDependencies,
    './DMPContainerBridgesModule': { DMPContainerBridgesModule: BridgeModule },
    '../DPages/DMPPageStyle': { DMPPageStyle },
    '../Utils/DMPMap': { DMPMap: { createFromDMPMap: value => new TestMap(value) } },
    '../EventTrack/Tags': { Tags: { BRIDGE: 'bridge' } },
    '../DApp/DMPApp': { DMPApp: { entryContext: { getContext: () => 'test-context' } } },
    '../Utils/DMPWindowUtils': { DMPWindowUtil: { setWindowBarDarkMode: (...args) => calls.push(args) } }
  })
  const record = { pageStyle: new DMPPageStyle(new Map(), 1) }
  const app = { appIndex: 1, currentWebViewId: 10,
    navigatorManager: { isRetainedInBackground: false, getPageRecordById: () => record } }
  const bridge = new DMPContainerBridgesModuleNavigationBar(app)
  presentedApp = app
  bridge.setNavigationBarColor(new Map([['frontColor', '#ffffff'], ['backgroundColor', '#26394d']]), null, 10)
  assert.equal(record.pageStyle.isStatusBarDarkMode(), false)
  assert.deepEqual(calls, [['test-context', false]])
  app.currentWebViewId = 11
  bridge.setNavigationBarColor(new Map([['frontColor', '#000000']]), null, 10)
  app.currentWebViewId = 10
  presentedApp = undefined
  bridge.setNavigationBarColor(new Map([['frontColor', '#ffffff']]), null, 10)
  presentedApp = app
  app.navigatorManager.isRetainedInBackground = true
  bridge.setNavigationBarColor(new Map([['frontColor', '#ffffff']]), null, 10)
  assert.equal(calls.length, 1)
})
