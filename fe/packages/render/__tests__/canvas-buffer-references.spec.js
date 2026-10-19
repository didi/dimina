import { afterEach, expect, it, vi } from 'vitest'
import { CanvasBufferReferences } from '../src/core/canvas-buffer-references.js'
import runtime from '../src/core/runtime.js'
import message from '../src/core/message.js'
function driver() {
  const arrays = new Map([[null, new Map()]]), buffers = new Set()
  const gl = { MAX_VERTEX_ATTRIBS: 0x8869, ARRAY_BUFFER: 0x8892, ELEMENT_ARRAY_BUFFER: 0x8893,
    ELEMENT_ARRAY_BUFFER_BINDING: 0x8895, VERTEX_ATTRIB_ARRAY_BUFFER_BINDING: 0x889f,
    current: null, array: null, failPointer: false, failDelete: false, errorReads: 0,
    getParameter(p) { if (p === this.MAX_VERTEX_ATTRIBS) return 8; if (p === 0x85b5) return this.current; if (p === this.ELEMENT_ARRAY_BUFFER_BINDING) return arrays.get(this.current).get('element') || null; return 0 },
    getVertexAttrib(i) { return arrays.get(this.current).get(i) || null },
    getError() { this.errorReads++; return 0 },
    createBuffer() { const value = { deleted: false }; buffers.add(value); return value },
    isBuffer(value) { return buffers.has(value) && !value.deleted },
    bindBuffer(target, buffer) { if (buffer?.deleted) return; if (target === this.ARRAY_BUFFER) this.array = buffer; if (target === this.ELEMENT_ARRAY_BUFFER) arrays.get(this.current).set('element', buffer) },
    vertexAttribPointer(i) { if (!this.array || this.failPointer) return; arrays.get(this.current).set(i >>> 0, this.array) },
    deleteBuffer(buffer) { if (!buffers.has(buffer) || buffer.deleted || this.failDelete) return; buffer.deleted = true; if (this.array === buffer) this.array = null; for (const [key, value] of arrays.get(this.current)) if (value === buffer) arrays.get(this.current).delete(key) },
  }
  const ext = { VERTEX_ARRAY_BINDING_OES: 0x85b5,
    createVertexArrayOES() { const vao = { deleted: false }; arrays.set(vao, new Map()); return vao },
    bindVertexArrayOES(vao) { if (!vao?.deleted) gl.current = vao },
    deleteVertexArrayOES(vao) { if (!vao || !arrays.has(vao) || vao.deleted) return; vao.deleted = true; if (gl.current === vao) gl.current = null },
    isVertexArrayOES(vao) { return arrays.has(vao) && vao !== null && !vao.deleted },
  }
  gl.getExtension = () => ext
  return { gl, ext, arrays }
}
function harness() {
  const d = driver(), references = new CanvasBufferReferences(d.gl)
  references.extensionEnabled(d.ext)
  const call = (name, args = [], id) => { references.before(name, args); const result = d.gl[name](...args); references.after(name, args, result, id, true, 'context'); return result }
  const extension = (name, args = []) => { const result = d.ext[name](...args); references.extensionCall(d.ext, name, args, result, true); return result }
  return { ...d, references, call, extension, ids: () => references.drain().map(value => value.id) }
}
it('retires a default-VAO buffer after real deletion without consuming GL errors', () => {
  const f = harness(), b = f.call('createBuffer', [], 'buffer')
  f.call('bindBuffer', [f.gl.ARRAY_BUFFER, b]); f.call('vertexAttribPointer', [0]); f.call('deleteBuffer', [b])
  expect(f.ids()).toEqual(['buffer']); expect(f.gl.errorReads).toBe(0)
})
it('keeps an inactive VAO reference until its last attachment is removed', () => {
  const f = harness(), b = f.call('createBuffer', [], 'buffer'), a = f.extension('createVertexArrayOES'), c = f.extension('createVertexArrayOES')
  f.call('bindBuffer', [f.gl.ARRAY_BUFFER, b])
  for (const vao of [a, c]) { f.extension('bindVertexArrayOES', [vao]); f.call('vertexAttribPointer', [0]) }
  f.extension('bindVertexArrayOES', [null]); f.call('deleteBuffer', [b]); expect(f.ids()).toEqual([])
  f.extension('deleteVertexArrayOES', [a]); expect(f.ids()).toEqual([])
  f.extension('deleteVertexArrayOES', [c]); expect(f.ids()).toEqual(['buffer'])
})
it('a repeated delete does not detach an already deleted buffer from the newly bound VAO', () => {
  const f = harness(), b = f.call('createBuffer', [], 'buffer'), vao = f.extension('createVertexArrayOES')
  f.extension('bindVertexArrayOES', [vao]); f.call('bindBuffer', [f.gl.ARRAY_BUFFER, b]); f.call('vertexAttribPointer', [0])
  f.extension('bindVertexArrayOES', [null]); f.call('deleteBuffer', [b]); f.extension('bindVertexArrayOES', [vao]); f.call('deleteBuffer', [b])
  expect(f.gl.getVertexAttrib(0)).toBe(b); expect(f.ids()).toEqual([])
})
it('tracks element-array attachments on their real VAO', () => {
  const f = harness(), b = f.call('createBuffer', [], 'index'), vao = f.extension('createVertexArrayOES')
  f.extension('bindVertexArrayOES', [vao]); f.call('bindBuffer', [f.gl.ELEMENT_ARRAY_BUFFER, b]); f.extension('bindVertexArrayOES', [null]); f.call('deleteBuffer', [b])
  expect(f.ids()).toEqual([]); f.extension('bindVertexArrayOES', [vao]); f.call('bindBuffer', [f.gl.ELEMENT_ARRAY_BUFFER, null]); expect(f.ids()).toEqual(['index'])
})
it('uses actual attribute readback when a pointer call fails', () => {
  const f = harness(), b = f.call('createBuffer', [], 'old'), next = f.call('createBuffer', [], 'next'), vao = f.extension('createVertexArrayOES')
  f.extension('bindVertexArrayOES', [vao]); f.call('bindBuffer', [f.gl.ARRAY_BUFFER, b]); f.call('vertexAttribPointer', [0]); f.call('bindBuffer', [f.gl.ARRAY_BUFFER, next])
  f.gl.failPointer = true; f.call('vertexAttribPointer', [0]); f.extension('bindVertexArrayOES', [null]); f.call('deleteBuffer', [b]); expect(f.ids()).toEqual([])
  f.gl.failPointer = false; f.extension('bindVertexArrayOES', [vao]); f.call('vertexAttribPointer', [0]); expect(f.ids()).toEqual(['old'])
})
it('keeps ownership if the driver still reports a valid buffer', () => {
  const f = harness(), b = f.call('createBuffer', [], 'buffer'); f.gl.failDelete = true; f.call('deleteBuffer', [b]); expect(f.ids()).toEqual([])
})
it('falls back conservatively for coercions and unknown vertex-array state', () => {
  for (const scenario of ['coercion', 'unknown']) {
    const f = harness(), b = f.call('createBuffer', [], 'buffer')
    if (scenario === 'coercion') f.references.before('vertexAttribPointer', [0.5])
    else { const foreign = {}; f.arrays.set(foreign, new Map()); f.gl.current = foreign; f.call('bindBuffer', [f.gl.ARRAY_BUFFER, b]); f.call('vertexAttribPointer', [0]) }
    f.call('deleteBuffer', [b]); expect(f.references.uncertain).toBe(true); expect(f.ids()).toEqual([])
  }
})
it('does not retire a foreign resource or an unregistered buffer', () => {
  const f = harness(), foreign = driver().gl.createBuffer()
  f.references.after('deleteBuffer', [foreign], undefined, undefined, false, 'other'); expect(f.ids()).toEqual([])
})
afterEach(() => { runtime.disposeCanvasNode('retire-node'); vi.restoreAllMocks() })
function scene() {
  const d = driver(), references = new CanvasBufferReferences(d.gl), sent = []
  references.extensionEnabled(d.ext)
  const node = { bridgeId: 'owner', canvas: {}, contexts: new Map([['context', d.gl]]), resourceIds: new Set(['context', 'extension']), bufferReferences: new Map([['context', references]]) }
  runtime.canvasNodes.set('retire-node', node); runtime.canvasResources.set('context', d.gl); runtime.canvasResources.set('extension', d.ext)
  vi.spyOn(message, 'send').mockImplementation(value => sent.push(value))
  const flush = (operations, synchronous = true) => runtime.canvasNodeFlush({ bridgeId: 'owner', synchronous, params: { nodeId: 'retire-node', trackRetiredBuffers: 1, operations } })
  return { ...d, node, references, sent, flush }
}
it('piggybacks bounded retirement proof on existing feedback and keeps caller-held renderer handles', () => {
  const f = scene(), operations = []
  for (let i = 0; i < 250; i++) {
    operations.push({ op: 'contextCall', contextId: 'context', method: 'createBuffer', args: [], resultId: 'buffer-' + i })
    operations.push({ op: 'contextCall', contextId: 'context', method: 'deleteBuffer', args: [{ __canvasResourceId: 'buffer-' + i }] })
  }
  f.flush(operations, false)
  expect(f.sent).toEqual([])
  expect(f.references.retired.size).toBe(250)
  const first = f.flush([]), second = f.flush([])
  expect(first.contexts.context.retiredBuffers.length).toBe(128)
  expect(second.contexts.context.retiredBuffers.length).toBe(122)
  expect(f.references.retired.size).toBe(0)
  expect(f.sent).toEqual([])
  expect(runtime.canvasResources.has('buffer-0')).toBe(true); expect(runtime.canvasResources.get('buffer-0').deleted).toBe(true)
})

it('keeps presentation-owned GL state outside retirement proof', () => {
  const d = driver(), node = { canvas: { getContext: () => d.gl, addEventListener() {}, removeEventListener() {} }, contexts: new Map(), resourceIds: new Set(), trackRetiredBuffers: true, presentation: {} }
  runtime.executeCanvasOperation(node, { op: 'getContext', contextType: 'webgl', contextId: 'context' }, 'owner')
  expect(node.bufferReferences).toBeUndefined()
  runtime.canvasResources.delete('context')
})
