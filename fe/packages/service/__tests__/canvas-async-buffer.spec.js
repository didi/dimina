import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { callback } from '@dimina/common'
import router from '../src/core/router.js'
import { createOffscreenCanvas } from '../src/api/core/ui/canvas/index.js'

const key = Symbol.for('dimina.canvas.createBufferAsync')
const nodes = [], pending = []
let bridgeId, originalInvoke, serial = 0
beforeEach(() => {
  bridgeId = 'async-buffer-' + serial++
  router.setInitId(bridgeId)
  originalInvoke = globalThis.DiminaServiceBridge.invoke
  globalThis.DiminaServiceBridge.canvasSyncSupported = true
  globalThis.DiminaServiceBridge.invoke = vi.fn(() => ({ contexts: {}, typedArrays: [] }))
  globalThis.DiminaServiceBridge.publish = vi.fn()
})
afterEach(async () => {
  for (const node of nodes.splice(0)) node.dispose()
  await Promise.allSettled(pending.splice(0))
  globalThis.DiminaServiceBridge.onMessage({ type: 'pageUnload', body: { bridgeId } })
  globalThis.DiminaServiceBridge.invoke = originalInvoke
  delete globalThis.DiminaServiceBridge.canvasSyncSupported
  vi.useRealTimers()
})
function create(flag = true, page = bridgeId) {
  globalThis.DiminaServiceBridge.onMessage({ type: 'canvasCapabilities', body: {
    bridgeId: page, capabilities: { webgl: { supported: true }, asyncBufferCreation: flag },
  } })
  const node = createOffscreenCanvas({ type: 'webgl' }); nodes.push(node)
  const gl = node.getContext('webgl')
  globalThis.DiminaServiceBridge.invoke.mockClear(); globalThis.DiminaServiceBridge.publish.mockClear()
  return { node, gl }
}
function allocate(gl) { const result = gl[key](); result.catch(() => {}); pending.push(result); return result }
function batches() { return globalThis.DiminaServiceBridge.publish.mock.calls.map(call => call[1].body.params) }
function ack(batch, created = true) {
  const op = batch.operations.find(op => op.method === 'createBuffer')
  callback.invoke(batch.feedback, { contexts: { [op.contextId]: { resources: [{ resourceId: op.resultId, metadata: { created } }] } }, typedArrays: [] })
  return op
}
it('is gated by the exact same-page capability and leaves public creation synchronous', async () => {
  for (const flag of [undefined, false, 'true', 1]) {
    const { gl } = create(flag === undefined ? null : flag)
    expect(gl[key]).toBeUndefined()
  }
  const { gl } = create(true)
  globalThis.DiminaServiceBridge.invoke.mockImplementation(({ body }) => {
    const op = body.params.operations[0]
    return { contexts: { [op.contextId]: { resources: [{ resourceId: op.resultId, metadata: { created: true } }] } } }
  })
  expect(gl.createBuffer()).toMatchObject({ resourceType: 'buffer' })
  expect(globalThis.DiminaServiceBridge.invoke).toHaveBeenCalledOnce()
})
it('keeps resource proxies non-thenable before Promise resolution', () => {
  const { gl } = create()
  allocate(gl)
  const resource = gl.resources.values().next().value
  expect(resource.then).toBeUndefined()
})
it('does not enable the private allocator from another page capability', () => {
  create(false)
  globalThis.DiminaServiceBridge.onMessage({ type: 'canvasCapabilities', body: {
    bridgeId: bridgeId + '-other', capabilities: { webgl: { supported: true }, asyncBufferCreation: true },
  } })
  const node = createOffscreenCanvas({ type: 'webgl' }); nodes.push(node)
  expect(node.getContext('webgl')[key]).toBeUndefined()
})
it('returns no resource before actual asynchronous created feedback and makes no sync query', async () => {
  const { gl } = create(), result = allocate(gl); let resolved = false
  result.then(() => { resolved = true })
  expect(globalThis.DiminaServiceBridge.invoke).not.toHaveBeenCalled()
  expect(batches()).toHaveLength(1)
  await Promise.resolve(); expect(resolved).toBe(false)
  const op = ack(batches()[0])
  expect(await result).toMatchObject({ __canvasResourceId: op.resultId })
  expect(gl.pendingBufferCreations.size).toBe(0)
})
it('preserves real allocation null and releases its pending record', async () => {
  const { gl } = create(), result = allocate(gl)
  const op = ack(batches()[0], false)
  expect(await result).toBeNull(); expect(gl.resources.has(op.resultId)).toBe(false)
})
it('rejects missing feedback and orders cleanup after creation', async () => {
  const { gl } = create(), result = allocate(gl), first = batches()[0]
  callback.invoke(first.feedback, {})
  await expect(result).rejects.toThrow('feedback missing')
  expect(batches().map(batch => batch.operations[0].method)).toEqual(['createBuffer', 'deleteBuffer'])
  expect(gl.pendingBufferCreations.size).toBe(0)
})
it('cancels on node disposal and ignores a late successful reply', async () => {
  const { node, gl } = create(), result = allocate(gl), batch = batches()[0]
  node.dispose()
  await expect(result).rejects.toThrow('canvas node disposed')
  ack(batch); expect(gl.pendingBufferCreations.size).toBe(0)
  expect(callback.callbacks[batch.feedback]).toBeUndefined()
})
it('rejects a context loss and clears its callback before a late reply', async () => {
  const { node, gl } = create(), result = allocate(gl), batch = batches()[0]
  node.dispatchEvent({ type: 'webglcontextlost' })
  await expect(result).rejects.toThrow('context changed')
  ack(batch); expect(callback.callbacks[batch.feedback]).toBeUndefined()
  expect(gl.pendingBufferCreations.size).toBe(0)
})
it('times out with bounded pending callbacks and cleans up the possibly allocated real object', async () => {
  vi.useFakeTimers()
  const { gl } = create(), result = allocate(gl), batch = batches()[0]
  await vi.advanceTimersByTimeAsync(4500)
  await expect(result).rejects.toThrow('timed out')
  expect(callback.callbacks[batch.feedback]).toBeUndefined()
  expect(batches().at(-1).operations[0].method).toBe('deleteBuffer')
})
it('keeps preceding canvas operations and resource creation in one FIFO batch', async () => {
  const { gl } = create()
  gl.clearColor(1, 0, 0, 1)
  const result = allocate(gl), batch = batches()[0]
  expect(batch.operations.map(op => op.method)).toEqual(['clearColor', 'createBuffer'])
  ack(batch); await result
})
it('does not mix responses between contexts', async () => {
  const a = create(), b = create(), one = allocate(a.gl), two = allocate(b.gl)
  const [first, second] = batches()
  const op2 = ack(second); expect(await two).toMatchObject({ __canvasResourceId: op2.resultId })
  let ready = false; one.then(() => { ready = true }); await Promise.resolve(); expect(ready).toBe(false)
  const op1 = ack(first); expect(await one).toMatchObject({ __canvasResourceId: op1.resultId })
})
it('bounds outstanding private requests', async () => {
  const { gl } = create()
  for (let index = 0; index < 64; index++) allocate(gl)
  await expect(allocate(gl)).rejects.toThrow('exceeds budget')
  expect(gl.pendingBufferCreations.size).toBe(64)
  for (const batch of batches()) ack(batch)
  await Promise.all(pending.slice(0, 64))
})
it('rejects transport failure without leaving callbacks or uncaught cleanup tasks', async () => {
  const { gl, node } = create()
  globalThis.DiminaServiceBridge.publish.mockImplementationOnce(() => { throw new Error('transport gone') })
  await expect(allocate(gl)).rejects.toThrow('transport gone')
  await Promise.resolve()
  expect(gl.pendingBufferCreations.size).toBe(0)
  expect(node.pendingCallbacks.size).toBe(0)
})

it('ignores callbacks captured before settlement when a context event arrives late', async () => {
  const { gl, node } = create(), captured = []
  const original = node.addEventListener.bind(node)
  vi.spyOn(node, 'addEventListener').mockImplementation((type, listener) => { captured.push(listener); return original(type, listener) })
  const result = allocate(gl), batch = batches()[0]
  ack(batch); const resource = await result
  expect(captured).toHaveLength(2)
  const sent = batches().length
  for (const listener of captured) expect(() => listener()).not.toThrow()
  expect(batches()).toHaveLength(sent)
  expect(gl.resources.get(resource.__canvasResourceId)).toBe(resource)
})
it('ignores a previously captured timeout after actual successful feedback', async () => {
  vi.useFakeTimers()
  const { gl } = create(), timeout = vi.spyOn(globalThis, 'setTimeout')
  const result = allocate(gl), batch = batches()[0]
  const late = timeout.mock.calls.find(args => args[1] === 4500)[0]
  ack(batch); await result
  const sent = batches().length
  expect(() => late()).not.toThrow()
  expect(batches()).toHaveLength(sent)
  timeout.mockRestore()
})
it('keeps a settled result when the bridge throws after synchronously delivering its feedback', async () => {
  const { gl } = create()
  globalThis.DiminaServiceBridge.publish.mockImplementationOnce((_type, request) => {
    ack(request.body.params)
    throw new Error('transport failed after delivery')
  })
  const result = await allocate(gl)
  expect(result).toMatchObject({ resourceType: 'buffer' })
  expect(gl.pendingBufferCreations.size).toBe(0)
})
