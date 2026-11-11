import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const require = createRequire(new URL('../../fe/packages/compiler/package.json', import.meta.url))
const { transformSync } = require('esbuild')
function load(name, deps) {
  const source = fs.readFileSync(new URL(`../dimina/src/main/ets/HybridContainer/${name}`, import.meta.url), 'utf8')
  const module = { exports: {} }
  vm.runInNewContext(transformSync(source, { loader: 'ts', format: 'cjs' }).code, {
    module, exports: module.exports, require: name => { assert.ok(name in deps, name); return deps[name] },
  })
  return module.exports
}
function fixture() {
  const calls = []
  const app = { appIndex: 1, render: { getController: () => ({ showFocusedKeyboard: () => calls.push('keyboard') }) } }
  const manager = { sharedInstance: () => ({ getApp: () => app }) }
  const logger = { DMPLogger: { w() {}, e() {} } }
  const proxy = load('DMPWebViewProxy.ets', {
    '../Service/DMPChannelProxyNext': { DMPChannelProxyNext: {
      messageHandlerNext: () => { calls.push('invoke'); return true }, RenderToService: () => calls.push('publish'),
    } },
    '../Utils/DMPMap': { DMPMap: { createFromObject: value => value } },
    '../DApp/DMPAppManager': { DMPAppManager: manager },
    '../EventTrack/DMPLogger': logger, '../EventTrack/Tags': { Tags: {} },
  })
  const { DMPWebViewController } = load('DMPWebViewController.ets', {
    '@ohos.web.webview': { WebviewController: class {} },
    '@kit.ArkTS': { util: { generateRandomUUID: () => 'frame' } },
    '../DApp/config/DMPAppConfig': {}, './DMPWebViewLifeCycle': { WebViewLifeCycle: class {} },
    './DMPWebViewProxy': proxy, '../Utils/DMPContextUtils': {}, './DMPKeyboardFocus': {},
    '@kit.IMEKit': {}, '../DApp/DMPAppManager': { DMPAppManager: manager },
    '../EventTrack/DMPLogger': logger, '../EventTrack/Tags': { Tags: {} },
  })
  const controller = new DMPWebViewController(1, app)
  controller.loadPath = () => 'http://127.0.0.1/pageFrame.html?vconsole=1'
  controller.getLastJavascriptProxyCallingFrameUrl = () => 'http://127.0.0.1/pageFrame.html'
  return { calls, controller, bridge: controller.getWebViewProxy() }
}
const message = { type: 'invokeAPI', target: 'container', body: {} }
test('trusted render frame can invoke, publish and request the keyboard', async () => {
  const f = fixture()
  assert.equal(f.bridge.invoke(message), true)
  await f.bridge.publish('{}'); await f.bridge.requestKeyboard(1)
  assert.deepEqual(f.calls, ['invoke', 'publish', 'keyboard'])
})
for (const url of ['https://h5.example/form', 'http://127.0.0.1/other.html', 'about:blank', '']) {
  test(`an embedded calling frame cannot use the host native proxy: ${url}`, async () => {
    const f = fixture()
    f.controller.getLastJavascriptProxyCallingFrameUrl = () => url
    assert.equal(f.bridge.invoke(message), false)
    await f.bridge.publish('{}'); await f.bridge.requestKeyboard(1)
    assert.deepEqual(f.calls, [])
  })
}
test('failure to identify the calling frame does not open native access', () => {
  const f = fixture()
  f.controller.getLastJavascriptProxyCallingFrameUrl = () => { throw new Error('not attached') }
  assert.equal(f.bridge.invoke(message), false)
  assert.deepEqual(f.calls, [])
})
