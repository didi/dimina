// Exercise real App entry/visibility methods; replace only native services and page rendering.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import vm from 'node:vm'

const require = createRequire(new URL('../../fe/packages/compiler/package.json', import.meta.url))
const { transformSync } = require('esbuild')
const root = new URL('../dimina/src/main/ets/', import.meta.url)
function load(path, dependencies = {}) {
  const { code } = transformSync(fs.readFileSync(new URL(path, root), 'utf8'), { loader: 'ts', format: 'cjs' })
  const module = { exports: {} }
  vm.runInNewContext(code, { module, exports: module.exports, require: name => dependencies[name] ?? {} })
  return module.exports
}

function fixture(ready = true) {
  const { DMPMap } = load('Utils/DMPMap.ts')
  const navigation = load('DApp/DMPMiniProgramPresentationStack.ets', { '../Utils/DMPMap': { DMPMap } })
  const { DMPAppVisibilityLedger } = load('DApp/utils/DMPAppVisibilityLedger.ets')
  const config = load('DApp/config/DMPLaunchConfig.ets')
  const messages = [], pages = []
  const manager = { retentionVisibility() {} }
  const { DMPApp } = load('DApp/DMPApp.ets', {
    '../EventTrack/DMPRuntimeDiagnostics': { DMPRuntimeDiagnostics: { launch() {} } },
    '../Utils/DMPMap': { DMPMap }, './DMPMiniProgramPresentationStack': navigation,
    './config/DMPLaunchConfig': config,
    './DMPAppManager': { DMPAppManager: { sharedInstance: () => manager } },
    '../Service/DMPChannelProxyNext': { DMPChannelProxyNext: { ContainerToService: message => messages.push(message.toJSON()) } },
  })
  // Bypass native engine initialization while retaining production methods and the real ledger.
  const app = Object.create(DMPApp.prototype)
  app._visibilityLedger = new DMPAppVisibilityLedger()
  if (ready) app._visibilityLedger.markServiceReady()
  app._navigatorManager = {
    getActivePageRecord: () => ({ webViewId: 7, pagePath: 'pages/index/index', params: new DMPMap({ query: new DMPMap({ id: '1' }) }) }),
    dispatchPageShow: id => pages.push(id),
  }
  const show = () => app.notifyMiniProgramShow(1001)
  const hide = () => app._visibilityLedger.request(false)
  const body = () => JSON.parse(JSON.stringify(messages.at(-1).body))
  return { app, messages, pages, DMPMap, show, hide, body }
}

test('retained entry delivers new path/query and ordinary foreground uses the current page', () => {
  const f = fixture()
  f.hide()
  f.app.prepareHostEntry({ appEntryPath: '/pages/detail/index?id=2&from=second', scene: 1011 })
  f.show()
  assert.equal(f.body().path, 'pages/detail/index')
  assert.deepEqual(f.body().query, { id: '2', from: 'second' })
  assert.equal(f.body().scene, 1011)
  f.show()
  assert.equal(f.messages.length, 1)
  f.hide(); f.show()
  assert.equal(f.body().path, 'pages/index/index')
  assert.deepEqual(f.body().query, { id: '1' })
})

test('visible reentry clears query and does not duplicate ordinary show events', () => {
  const f = fixture()
  f.app.prepareHostEntry({ appEntryPath: 'pages/detail/index', query: new f.DMPMap({ id: '2' }) })
  f.show()
  assert.deepEqual(f.body().query, { id: '2' })
  f.app.prepareHostEntry({ appEntryPath: 'pages/detail/index' })
  f.show()
  assert.deepEqual(f.body().query, {})
  f.show()
  assert.equal(f.messages.length, 2)
  assert.deepEqual(f.pages, [])
})

test('a deferred host entry is delivered only when the host resumes', () => {
  const f = fixture()
  f.hide()
  f.app.prepareHostEntry({ appEntryPath: 'pages/detail/index?id=2', scene: 1011 })
  f.app.stashMiniProgramShow(1011)
  assert.equal(f.messages.length, 0)
  f.show()
  assert.deepEqual(f.body().query, { id: '2' })
  assert.equal(f.body().scene, 1011)
})

test('entry during runtime initialization waits for readiness and delivers once', () => {
  const f = fixture(false)
  f.app.prepareHostEntry({ appEntryPath: 'pages/detail/index?id=2' })
  f.show()
  assert.equal(f.messages.length, 0)
  f.app.notifyServiceReady()
  assert.deepEqual(f.body().query, { id: '2' })
  f.app.notifyServiceReady()
  f.show()
  assert.equal(f.messages.length, 1)
})

test('missing path uses the current page and a mini-program return replaces host entry options', () => {
  const f = fixture()
  f.app.prepareHostEntry({ appEntryPath: 'pages/detail/index?id=2' })
  f.show()
  f.hide()
  f.app.clearHostEntryOptions()
  f.app.notifyMiniProgramShow(1038, new f.DMPMap({ appId: 'target' }))
  assert.deepEqual(f.body().query, { id: '1' })
  assert.equal(f.body().scene, 1038)
  f.app.prepareHostEntry({})
  f.show()
  assert.equal(f.body().path, 'pages/index/index')
  assert.deepEqual(f.body().query, { id: '1' })
  assert.deepEqual(f.body().referrerInfo, {})
})
