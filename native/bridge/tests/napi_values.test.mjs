import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
const { roundTrip } = createRequire(import.meta.url)(process.env.DIMINA_NAPI_MODULE)

test('N-API / QuickJS preserves large nested and empty buffers without JSON', () => {
  const bytes = new Uint8Array(8 * 1024 * 1024).fill(173)
  bytes[0] = 0; bytes[bytes.length - 1] = 255
  const text = '中文\0🎮\ud800'
  const stringify = JSON.stringify
  JSON.stringify = () => { throw new Error('binary data must not be serialized') }
  let result
  try {
    result = roundTrip({ data: bytes.buffer, empty: new ArrayBuffer(0), text,
      entries: { 'a.bin': { data: new Uint8Array([1, 2, 255]).buffer } },
      list: [null, true, 42, undefined], ['__proto__']: 'own property' })
  } finally { JSON.stringify = stringify }
  bytes[1] = 7
  assert.ok(result.data instanceof ArrayBuffer)
  assert.equal(result.data.byteLength, 8388608)
  assert.deepEqual([...new Uint8Array(result.data).slice(0, 2)], [0, 173])
  assert.equal(new Uint8Array(result.data)[8388607], 255)
  assert.ok(result.empty instanceof ArrayBuffer)
  assert.equal(result.empty.byteLength, 0)
  assert.equal(result.text, text)
  assert.deepEqual([...new Uint8Array(result.entries['a.bin'].data)], [1, 2, 255])
  assert.deepEqual(result.list, [null, true, 42, undefined])
  assert.equal(Object.getPrototypeOf(result), Object.prototype)
  assert.equal(result.__proto__, 'own property')
})

test('N-API honors DMPMap toJSON wrappers and copies only own properties', () => {
  const wrapped = { toJSON: () => ({ data: new Uint8Array([128, 255]).buffer }) }
  assert.deepEqual([...new Uint8Array(roundTrip({ wrapped }).wrapped.data)], [128, 255])
  const source = Object.assign(Object.create({ inherited: true }), { own: 1 })
  assert.deepEqual(roundTrip(source), { own: 1 })
})

test('N-API rejects cycles and preserves property getter failures', () => {
  const cycle = {}; cycle.self = cycle
  assert.throws(() => roundTrip(cycle), /cyclic|nested/)
  assert.throws(() => roundTrip({ get data() { throw new Error('getter failure') } }), /getter failure/)
})
