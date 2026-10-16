import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { test } from 'node:test'

const library = fs.readFileSync(process.env.DIMINA_LIBPAG_SOURCE ?? new URL('../../examples/miniprogram/base/miniprogram_npm/libpag-miniprogram/index.js', import.meta.url), 'utf8')
const begin = library.indexOf('function destroyVerify$1(')
const end = library.indexOf('\nconst measureText =', begin)
assert.ok(begin > 0 && end > begin)

function frameFromOptions(options) {
  const context = vm.createContext({ console, ArrayBuffer, Uint8Array })
  vm.runInContext(library.slice(begin, end) + ';globalThis.frameFromOptions = frameDataOptions2FrameData', context)
  return context.frameFromOptions(7, options)
}

test('libpag reuses only explicitly owned independent native ArrayBuffers', () => {
  const data = Uint8Array.of(17, 19, 23, 255).buffer
  const frame = frameFromOptions({ data, dataOwned: true, width: 1, height: 1 })
  assert.equal(frame.data, data, 'an independently owned frame needs no second RGBA allocation')
  assert.equal(frame.id, 7)
  assert.deepEqual([...new Uint8Array(frame.data)], [17, 19, 23, 255])
})

test('libpag keeps the defensive copy for old native hosts and WeChat frames', () => {
  for (const dataOwned of [undefined, false, 1, 'true', null]) {
    const bytes = Uint8Array.of(17, 19, 23, 255)
    const frame = frameFromOptions({ data: bytes.buffer, dataOwned, width: 1, height: 1 })
    assert.notEqual(frame.data, bytes.buffer)
    bytes.fill(0)
    assert.deepEqual([...new Uint8Array(frame.data)], [17, 19, 23, 255])
  }
})

test('libpag does not treat shared storage as an independently owned frame', () => {
  const data = new SharedArrayBuffer(4), bytes = new Uint8Array(data)
  bytes.set([17, 19, 23, 255])
  const frame = frameFromOptions({ data, dataOwned: true, width: 1, height: 1 })
  assert.ok(frame.data instanceof ArrayBuffer)
  assert.notEqual(frame.data, data)
  bytes.fill(0)
  assert.deepEqual([...new Uint8Array(frame.data)], [17, 19, 23, 255])
})

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

async function playbackFixture() {
  const intervals = new Map(), listeners = new Map(), seeks = [], errors = [], frames = []
  let serial = 0
  const decoder = {
    on(name, listener) { listeners.set(name, listener) },
    start: async () => ({}),
    seek: async position => { seeks.push(position) },
    getFrameData: () => frames.shift() ?? null,
    remove() {},
  }
  const context = vm.createContext({
    console: { error: (...args) => errors.push(args) },
    setInterval(fn) { intervals.set(++serial, fn); return serial },
    clearInterval(id) { intervals.delete(id) },
    wx: { createVideoDecoder: () => decoder },
    MP4_CACHE_PATH: '/video/', touchDirectory() {}, writeFile() {}, removeFile() {},
    PAGModule: { currentPlayer: null },
    ArrayBufferImage: class { setFrameData(frame) { this.frame = frame } },
  })
  vm.runInContext(library.slice(begin, end) + ';globalThis.Reader = VideoReader', context)
  const reader = new context.Reader(new Uint8Array([1]), 1, 1, 25, [])
  await reader.videoDecoderPromise
  return { reader, intervals, seeks, errors, frames, ended: () => listeners.get('ended')(),
    tick: () => { for (const fn of [...intervals.values()]) fn() } }
}

test('decoder EOF preserves the unread tail and stops polling without rewinding', async () => {
  const f = await playbackFixture()
  f.reader.currentFrame = 238
  f.reader.bufferIndex = 240
  const tail = { id: 239, data: Uint8Array.of(3, 5, 7, 255).buffer, width: 1, height: 1 }
  f.reader.frameDataBuffers.push(tail)
  f.ended()
  await Promise.resolve()
  assert.deepEqual(f.seeks, [], 'prefetch EOF must not seek away from the still-unread tail')
  assert.equal(f.reader.bufferIndex, 240, 'EOF must preserve the next sequential frame index')
  assert.equal(f.intervals.size, 0, 'EOF must stop polling an exhausted decoder')
  assert.equal(f.reader.frameDataBuffers[0], tail)
})

test('the last buffered frame remains available after decoder EOF', async () => {
  const f = await playbackFixture()
  f.reader.currentFrame = 238
  f.reader.bufferIndex = 240
  const tail = { id: 239, data: Uint8Array.of(9, 11, 13, 255).buffer, width: 1, height: 1 }
  f.reader.frameDataBuffers.push(tail)
  f.ended()
  await f.reader.prepare(239)
  assert.equal(f.reader.arrayBufferImage.frame, tail)
  assert.equal(f.reader.currentFrame, 239)
  assert.deepEqual(f.seeks, [], 'consuming a buffered tail must not rebuild or rewind the decoder')
})

test('playback loops by seeking only when the requested frame wraps to the start', async () => {
  const f = await playbackFixture()
  f.reader.currentFrame = 239
  f.reader.bufferIndex = 240
  f.ended()
  assert.deepEqual(f.seeks, [], 'EOF alone does not request another loop')
  const prepared = f.reader.prepare(0)
  await new Promise(setImmediate)
  assert.deepEqual(f.seeks, [0])
  assert.equal(f.reader.seeking, false)
  assert.equal(f.intervals.size, 1, 'the new seek resumes polling for real decoded frames')
  f.frames.push({ data: Uint8Array.of(17, 19, 23, 255).buffer, width: 1, height: 1 })
  f.tick()
  await prepared
  assert.equal(f.reader.currentFrame, 0)
  assert.equal(f.reader.arrayBufferImage.frame.id, 0)
  assert.deepEqual([...new Uint8Array(f.reader.arrayBufferImage.frame.data)], [17, 19, 23, 255])
  f.reader.onDestroy()
  assert.equal(f.intervals.size, 0)
})

test('a late decoder EOF after reader destruction performs no seek or guarded cleanup', async () => {
  const f = await playbackFixture()
  f.reader.onDestroy()
  f.ended()
  await Promise.resolve()
  assert.deepEqual(f.seeks, [])
  assert.deepEqual(f.errors, [])
  assert.equal(f.intervals.size, 0)
})
