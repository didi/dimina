import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { test } from 'node:test'

const library = fs.readFileSync(new URL('../../examples/miniprogram/base/miniprogram_npm/libpag-miniprogram/index.js', import.meta.url), 'utf8')
const begin = library.indexOf('function destroyVerify$1(')
const end = library.indexOf('\nconst measureText =', begin)
assert.ok(begin > 0 && end > begin)

test('vendored libpag stops video polling before its destroy guard takes effect', () => {
  const intervals = new Map()
  const errors = []
  let serial = 0
  let reads = 0
  let removals = 0
  let unlinks = 0
  const context = vm.createContext({
    console: { error: (...args) => errors.push(args) },
    setInterval(fn) { intervals.set(++serial, fn); return serial },
    clearInterval(id) { intervals.delete(id) },
  })
  vm.runInContext(library.slice(begin, end) + ';globalThis.Reader = VideoReader', context)
  const reader = Object.create(context.Reader.prototype)
  Object.assign(reader, {
    isDestroyed: false, frameDataBuffers: [], bufferIndex: 0,
    videoDecoder: { getFrameData() { reads++; return null }, remove() { removals++ } },
    player: { unlinkVideoReader(value) { assert.equal(value, reader); unlinks++ } },
    getFrameDataResolve() { assert.equal(reader.isDestroyed, true) },
  })
  reader.startGetFrameDataLoop()
  assert.equal(intervals.size, 1)
  for (const tick of intervals.values()) tick()
  assert.equal(reads, 1)
  reader.onDestroy()
  assert.equal(intervals.size, 0, 'destroy must cancel the real polling interval')
  assert.equal(reader.getFrameDataLoopTimer, null)
  assert.equal(reader.getFrameDataLooping, false)
  assert.equal(reader.isDestroyed, true)
  assert.equal(removals, 1)
  assert.equal(unlinks, 1)
  assert.deepEqual(errors, [], 'cleanup must not call a method blocked by destroyVerify')
  for (const tick of intervals.values()) tick()
  assert.equal(reads, 1)
})
