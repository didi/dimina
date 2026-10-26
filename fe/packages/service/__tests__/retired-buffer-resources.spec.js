import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import router from '../src/core/router.js'
import { createOffscreenCanvas } from '../src/api/core/ui/canvas/index.js'
let id = 0, invoke, publish
const nodes = []
class TestWeakRef { constructor(value) { this.value = value } deref() { return this.value } clear() { this.value = undefined } }
beforeEach(() => {
  invoke = globalThis.DiminaServiceBridge.invoke; publish = globalThis.DiminaServiceBridge.publish
  globalThis.DiminaServiceBridge.canvasSyncSupported = true
  globalThis.DiminaServiceBridge.publish = () => {}
  globalThis.DiminaServiceBridge.invoke = ({ body }) => {
    const contexts = {}
    for (const op of body.params.operations) {
      contexts[op.contextId] ||= { resources: [] }
      if (op.resultId) contexts[op.contextId].resources.push({ resourceId: op.resultId, metadata: { created: true } })
    }
    return { contexts, typedArrays: [] }
  }
  vi.stubGlobal('WeakRef', TestWeakRef)
})
afterEach(() => {
  for (const n of nodes.splice(0)) { n.dispose(); globalThis.DiminaServiceBridge.onMessage({ type: 'pageUnload', body: { bridgeId: n.bridgeId } }) }
  vi.unstubAllGlobals(); globalThis.DiminaServiceBridge.invoke = invoke; globalThis.DiminaServiceBridge.publish = publish
  delete globalThis.DiminaServiceBridge.canvasSyncSupported
})
function context() { router.setInitId('retired-' + id++); const canvas = createOffscreenCanvas({ type: 'webgl' }); nodes.push(canvas); return { canvas, gl: canvas.getContext('webgl') } }
function ack(gl) { gl.retireBufferReferences([...gl.resources.keys()]) }
it('keeps a live buffer strongly, then preserves a caller-held deleted proxy on readback', () => {
  const { gl } = context(), buffer = gl.createBuffer(), key = buffer.__canvasResourceId
  expect(gl.resources.get(key)).toBe(buffer); gl.deleteBuffer(buffer); ack(gl)
  expect(gl.resources.has(key)).toBe(false); expect(buffer.deleted).toBe(true)
  expect(gl.deserializeFeedbackValue({ __canvasResourceId: key })).toBe(buffer)
  expect(gl.retiredBufferResources.entries.size).toBe(1)
})
it('returns null for a collected proxy and keeps a replacement index generation', () => {
  const { gl } = context(), buffer = gl.createBuffer(), key = buffer.__canvasResourceId
  gl.deleteBuffer(buffer); ack(gl); gl.retiredBufferResources.entries.get(key).reference.clear()
  expect(gl.deserializeFeedbackValue({ __canvasResourceId: key })).toBeNull()
  const replacement = { marker: 'next index generation' }
  gl.retiredBufferResources.remember(key, replacement)
  expect(gl.retiredBufferResources.get(key)).toBe(replacement)
})
it('keeps the ordinary resource path without WeakRef', () => {
  vi.stubGlobal('WeakRef', undefined); const { gl } = context(), buffer = gl.createBuffer(); gl.deleteBuffer(buffer); ack(gl)
  expect(gl.resources.get(buffer.__canvasResourceId)).toBe(buffer); expect(gl.retiredBufferResources.enabled).toBe(false)
})
it('needs no FinalizationRegistry to retain a caller-held proxy', () => {
  vi.stubGlobal('FinalizationRegistry', undefined); const { gl } = context(), buffer = gl.createBuffer(); gl.deleteBuffer(buffer); ack(gl)
  expect(gl.resources.has(buffer.__canvasResourceId)).toBe(false)
  expect(gl.deserializeFeedbackValue({ __canvasResourceId: buffer.__canvasResourceId })).toBe(buffer)
})
it('retains the strong owner if weak allocation fails', () => {
  const { gl } = context(), buffer = gl.createBuffer()
  vi.stubGlobal('WeakRef', class { constructor() { throw new Error('weak allocation failed') } })
  expect(() => { gl.deleteBuffer(buffer); ack(gl) }).not.toThrow()
  expect(gl.resources.get(buffer.__canvasResourceId)).toBe(buffer)
  expect(gl.retiredBufferResources.entries.size).toBe(0)
})
it('does not retire another canvas buffer or change texture retention', () => {
  const one = context(), two = context(), buffer = one.gl.createBuffer(), texture = one.gl.createTexture()
  two.gl.deleteBuffer(buffer); ack(two.gl); one.gl.deleteTexture(texture); one.gl.retireBufferReferences([texture.__canvasResourceId])
  expect(one.gl.resources.get(buffer.__canvasResourceId)).toBe(buffer)
  expect(one.gl.resources.get(texture.__canvasResourceId)).toBe(texture)
  expect(two.gl.retiredBufferResources.entries.size).toBe(0)
})
it('clears on owner disposal and never resurrects from late feedback', () => {
  const { canvas, gl } = context(), buffer = gl.createBuffer(); gl.deleteBuffer(buffer); ack(gl)
  canvas.dispose()
  expect(gl.retiredBufferResources.entries.size).toBe(0); expect(gl.retiredBufferResources.enabled).toBe(false)
  expect(gl.retiredBufferResources.remember(buffer.__canvasResourceId, buffer)).toBe(false)
  expect(gl.deserializeFeedbackValue({ __canvasResourceId: buffer.__canvasResourceId })).toBeNull()
})
it('rejects malformed or unrelated readback ids without creating a resource', () => {
  const { gl } = context()
  expect(gl.deserializeFeedbackValue({ __canvasResourceId: 42 })).toBeNull()
  expect(gl.deserializeFeedbackValue({ __canvasResourceId: 'webgl_texture_missing' })).toBeNull()
  expect(gl.retiredBufferResources.entries.size).toBe(0)
})

it('waits for renderer retirement proof before dropping the strong proxy', () => {
  const { gl, canvas } = context(), buffer = gl.createBuffer(); buffer.custom = { state: 42 }
  gl.deleteBuffer(buffer)
  expect(gl.resources.get(buffer.__canvasResourceId)).toBe(buffer)
  canvas.applyFlushFeedback({ contexts: { [gl.contextId]: { retiredBuffers: [buffer.__canvasResourceId] } } })
  expect(gl.resources.has(buffer.__canvasResourceId)).toBe(false)
  const returned = gl.deserializeFeedbackValue({ __canvasResourceId: buffer.__canvasResourceId })
  expect(returned).toBe(buffer); expect(returned.custom.state).toBe(42)
})

it('prunes dead names incrementally with bounded work', () => {
  const { gl } = context(), index = gl.retiredBufferResources
  for (let i = 0; i < 12; i++) index.remember('old-' + i, { i })
  for (const record of index.entries.values()) record.reference.clear()
  index.sweepCursor = null; index.remember('held', { identity: 352 })
  expect(index.entries.size).toBe(9)
  expect(index.get('held').identity).toBe(352)
})
