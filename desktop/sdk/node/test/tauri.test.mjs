import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mockIPC, clearMocks } from '@tauri-apps/api/mocks'
import { Dimina, DiminaWindow } from '../tauri.js'

test('Tauri uses plugin commands for the full window lifecycle and propagates errors', async () => {
  globalThis.window = {}
  const calls = []
  let info
  mockIPC((command, payload) => {
    calls.push([command, payload])
    switch (command) {
      case 'plugin:dimina|start': return null
      case 'plugin:dimina|open':
        if (payload.options.appId === 'broken') throw new Error('startup failed')
        return info = { id: 'one', appId: payload.options.appId, name: 'Demo', ready: true }
      case 'plugin:dimina|windows': return info ? [info] : []
      case 'plugin:dimina|close': info = undefined; return null
      case 'plugin:dimina|focus': return null
      case 'plugin:dimina|close_all': info = undefined; return null
      case 'plugin:dimina|import': return { appId: 'imported', imported: true }
      case 'plugin:dimina|dispose': return null
      default: throw new Error(`Unknown plugin command: ${command}`)
    }
  })
  try {
    const sdk = await Dimina.start()
    const app = await sdk.openApp({ appId: 'demo', path: 'pages/index' })
    assert.ok(app instanceof DiminaWindow)
    assert.equal(app.ready, true)
    assert.deepEqual(calls[1], ['plugin:dimina|open', { options: { appId: 'demo', path: 'pages/index' } }])
    const [listed] = await sdk.windows()
    await listed.focus()
    assert.deepEqual(calls.at(-1), ['plugin:dimina|focus', { id: 'one' }])
    await listed.close()
    assert.equal((await sdk.windows()).length, 0)
    assert.equal((await sdk.importApp('/absolute/package')).imported, true)
    await assert.rejects(sdk.openApp({ appId: 'broken' }), /startup failed/)
    await sdk.closeAll()
    await sdk.dispose()
    await sdk.dispose()
    assert.equal(calls.filter(([command]) => command === 'plugin:dimina|dispose').length, 1)
    await assert.rejects(sdk.windows(), /stopped/)
  } finally { clearMocks(); delete globalThis.window }
})
