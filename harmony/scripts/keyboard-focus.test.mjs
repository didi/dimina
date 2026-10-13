import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { test } from 'node:test'
const require = createRequire(new URL('../../fe/packages/compiler/package.json', import.meta.url))
const { transformSync } = require('esbuild')
function load(name, deps = {}) {
  const source = fs.readFileSync(new URL(`../dimina/src/main/ets/HybridContainer/${name}`, import.meta.url), 'utf8')
  const module = { exports: {} }
  vm.runInNewContext(transformSync(source, { loader: 'ts', format: 'cjs' }).code, {
    module, exports: module.exports, require: name => { assert.ok(name in deps, name); return deps[name] },
  })
  return module.exports
}
const focus = load('DMPKeyboardFocus.ts')
function fixture() {
  let shown = 0
  const app = { currentWebViewId: 1, navigatorManager: { isRetainedInBackground: false }, render: { invalidateCanvasUi() {} } }
  const manager = { isHostVisible: () => true, getPresentedApp: () => app }
  const { DMPWebViewController } = load('DMPWebViewController.ets', {
    '@ohos.web.webview': { WebviewController: class {} },
    '../DApp/config/DMPAppConfig': {},
    './DMPWebViewLifeCycle': { WebViewLifeCycle: class { notifyPageBegin() {} } },
    './DMPWebViewProxy': { DMPWebViewProxy: class {} },
    '../Utils/DMPContextUtils': {}, './DMPKeyboardFocus': focus,
    '@kit.IMEKit': { inputMethod: { getController: () => ({ showTextInput: async () => { shown++ } }) } },
    '../DApp/DMPAppManager': { DMPAppManager: { sharedInstance: () => manager } },
    '../EventTrack/DMPLogger': { DMPLogger: { w() {} } }, '../EventTrack/Tags': { Tags: {} },
  })
  const controller = new DMPWebViewController(1, app)
  controller.isControllerAttached = true
  controller.webContainer = { hasWebFocus: true, modalInteractionBlocked: false }
  controller.requestFocus = () => {}
  controller.runJavaScript = async () => 'true'
  return { controller, app, manager, shown: () => shown }
}
test('foreground focused input requests the keyboard', async () => {
  const f = fixture(); await f.controller.showFocusedKeyboard(1); assert.equal(f.shown(), 1)
})
for (const scenario of ['background', 'otherPage', 'otherApp', 'retained', 'modal', 'blur', 'detach', 'navigation']) {
  test(`pending focus cannot show a keyboard after ${scenario}`, async () => {
    const f = fixture(); let finish
    f.controller.runJavaScript = () => new Promise(resolve => { finish = resolve })
    const pending = f.controller.showFocusedKeyboard(1)
    if (scenario === 'background') f.manager.isHostVisible = () => false
    if (scenario === 'otherPage') f.app.currentWebViewId = 2
    if (scenario === 'otherApp') f.manager.getPresentedApp = () => ({})
    if (scenario === 'retained') f.app.navigatorManager.isRetainedInBackground = true
    if (scenario === 'modal') f.controller.webContainer.modalInteractionBlocked = true
    if (scenario === 'blur') f.controller.webContainer.hasWebFocus = false
    if (scenario === 'detach') f.controller.notifyControllerDetached()
    if (scenario === 'navigation') f.controller.notifyPageBegin()
    finish('true'); await pending; assert.equal(f.shown(), 0)
  })
}
test('a newer focus supersedes an older outstanding request', async () => {
  const f = fixture(); const callbacks = []
  f.controller.runJavaScript = () => new Promise(resolve => callbacks.push(resolve))
  const first = f.controller.showFocusedKeyboard(1), second = f.controller.showFocusedKeyboard(2)
  callbacks[1]('true'); await second; callbacks[0]('true'); await first
  assert.equal(f.shown(), 1)
})
test('DOM focus observer rejects blur, disabled, readonly and non-text controls', () => {
  const listeners = {}, window = {}
  const e = { tagName: 'INPUT', type: 'text', isConnected: true, getClientRects: () => [1] }
  const document = { activeElement: e, hasFocus: () => true, addEventListener: (name, fn) => { listeners[name] = fn } }
  const requests = []
  const context = vm.createContext({ window, document, DiminaRenderBridge: { requestKeyboard: n => requests.push(n) } })
  vm.runInContext(focus.DMP_KEYBOARD_FOCUS_SCRIPT, context)
  listeners.focusin(); assert.deepEqual(requests, [1])
  assert.equal(vm.runInContext(focus.keyboardFocusCheck(1), context), true)
  for (const [key, value] of [['disabled', true], ['readOnly', true], ['inputMode', 'none'], ['type', 'checkbox']]) {
    const old = e[key]; e[key] = value
    assert.equal(vm.runInContext(focus.keyboardFocusCheck(1), context), false); e[key] = old
  }
  listeners.focusout(); assert.equal(vm.runInContext(focus.keyboardFocusCheck(1), context), false)
})
test('initial DOM focus waits for native Web focus without a timer', async () => {
  const f = fixture(); f.controller.webContainer.hasWebFocus = false
  await f.controller.showFocusedKeyboard(1); assert.equal(f.shown(), 0)
  f.controller.webContainer.hasWebFocus = true
  await f.controller.flushFocusedKeyboard(); assert.equal(f.shown(), 1)
  await f.controller.flushFocusedKeyboard(); assert.equal(f.shown(), 1)
})
test('native blur cancels a request even if the Web refocuses before its callback', async () => {
  const f = fixture(); let finish
  f.controller.runJavaScript = () => new Promise(resolve => { finish = resolve })
  const pending = f.controller.showFocusedKeyboard(1)
  f.controller.cancelFocusedKeyboard()
  finish('true'); await pending; assert.equal(f.shown(), 0)
})
