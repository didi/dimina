import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { copyFile, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Dimina } from '../index.js'
import { buildTestRuntime } from '../../tauri/tests/testdata/runtime/build.mjs'

const fixtureRoot = await mkdtemp(join(tmpdir(), 'dimina native fixture '))
const executable = process.platform === 'win32' ? 'runtime.exe' : 'runtime'
const nativeRuntime = process.env.DIMINA_TEST_RUNTIME || buildTestRuntime(join(fixtureRoot, executable))
after(() => rm(fixtureRoot, { recursive: true, force: true }))

async function fixture(t, mode = 'normal') {
  const dir = await mkdtemp(join(tmpdir(), 'dimina sdk '))
  const runtimePath = join(dir, executable)
  await copyFile(nativeRuntime, runtimePath)
  await writeFile(join(dir, 'fixture.json'), JSON.stringify({ mode }))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  return { runtimePath, packagesDir: dir, dataDir: dir }
}

async function assertRuntimeExited(options) {
  const pid = Number(await readFile(join(options.dataDir, 'pid'), 'utf8'))
  for (let attempt = 0; attempt < 100; attempt++) {
    try { process.kill(pid, 0) } catch (error) {
      if (error.code === 'ESRCH') return
      throw error
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail('SDK left its runtime process running')
}

test('opens, focuses, lists, imports and closes through the managed protocol', async t => {
  const options = await fixture(t)
  const host = await Dimina.start(options)
  try {
    const first = await host.openApp({ appId: 'demo', name: 'Demo' })
    assert.equal(first.ready, true)
    assert.equal((await host.windows()).length, 1)
    await first.focus()
    assert.equal((await host.openApp({ appId: 'demo' })).id, first.id)
    assert.equal((await host.importApp('/absolute/package')).appId, 'imported')
    await assert.rejects(host.openApp({ appId: 'broken' }), /startup failed/)
    await first.close()
    await first.close()
    assert.equal((await host.windows()).length, 0)
    const second = await host.openApp({ appId: 'demo' })
    assert.notEqual(first.id, second.id)
    await host.closeAll()
  } finally { await host.dispose() }
  await assert.rejects(host.windows(), /stopped/)
  await host.dispose()
  await assertRuntimeExited(options)
})

test('rejects a mismatched runtime protocol', async t => {
  const options = await fixture(t, 'wrong')
  await assert.rejects(Dimina.start(options), /handshake/)
  await assertRuntimeExited(options)
})

test('bounds runtime startup and cleans up a child that never responds', async t => {
  const options = await fixture(t, 'hang')
  await assert.rejects(Dimina.start({ ...options, startupTimeoutMs: 2000 }), /timed out/)
  await assertRuntimeExited(options)
})

test('rejects ambiguous relative executable and data locations', async () => {
  await assert.rejects(Dimina.start({ runtimePath: 'relative', packagesDir: '/apps', dataDir: '/data' }), /absolute/)
})

test('dispatches native requests over private stdio with identity, results and cancellation', async t => {
  const options = await fixture(t, 'native')
  const host = await Dimina.start(options)
  let cancelled, started
  const running = new Promise(resolve => { started = resolve })
  const cancellation = new Promise(resolve => { cancelled = resolve })
  try {
    await host.registerApi('getNetworkType', async (params, context) => {
      assert.ok(context.windowId)
      if (context.appId === 'error') throw new Error('user denied')
      return { message: params.message + context.appId }
    }, { appIds: ['demo', 'error'] })
    await host.registerApi('openSetting', (_params, context) => {
      started()
      if (context.signal.aborted) cancelled()
      else context.signal.addEventListener('abort', cancelled, { once: true })
      return new Promise(() => {})
    })
    assert.equal((await host.openApp({ appId: 'demo' })).name, '你好demo')
    assert.equal((await host.openApp({ appId: 'error' })).name, 'user denied')
    const pending = await host.openApp({ appId: 'cancel' })
    await running
    await pending.close()
    await Promise.race([cancellation, new Promise((_, reject) => setTimeout(() => reject(new Error('Native call did not cancel')), 1000))])
  } finally { await host.dispose() }
  await assertRuntimeExited(options)
})

for (const mode of ['stall-close', 'ignore-shutdown']) test(`bounds disposal when runtime ${mode} and shares concurrent disposal`, async t => {
  const options = await fixture(t, mode)
  const host = await Dimina.start(options)
  const first = host.dispose(), second = host.dispose()
  const results = Promise.allSettled([first, second])
  let timer
  try {
    await Promise.race([results, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Runtime disposal exceeded its deadline')), 7500) })])
    assert.equal(first, second, 'concurrent disposal must share a promise')
    await assertRuntimeExited(options)
  } finally {
    clearTimeout(timer)
    const pid = Number(await readFile(join(options.dataDir, 'pid'), 'utf8'))
    try { process.kill(pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
    await results
  }
})

test('does not dispatch a queued native request after its cancellation arrives', async t => {
  const options = await fixture(t, 'native'), host = await Dimina.start(options)
  let invoked = 0
  try {
    await host.registerApi('openSetting', () => { invoked++; return {} })
    await host.openApp({ appId: 'cancel-queued' })
    assert.equal(invoked, 0, 'cancelled request started its handler')
  } finally { await host.dispose() }
})
