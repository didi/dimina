import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const minBytes = 64 * 1024
const maxBytes = 32 * 1024 * 1024
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dimina-canvas-rle32-'))
// Set this to retain native fixtures for the Render-side decoder tests.
const fixtureDirectory = process.env.CANVAS_RLE32_FIXTURE_DIR ?? path.join(directory, 'fixtures')
const executable = path.join(directory, 'canvas-rle32')

before(() => {
  fs.mkdirSync(fixtureDirectory, { recursive: true })
  const fixture = fileURLToPath(new URL('./fixtures/canvas-rle32.cpp', import.meta.url))
  const includes = fileURLToPath(new URL('../dimina/src/main/cpp/', import.meta.url))
  const compile = spawnSync(process.env.CXX ?? 'c++', [
    '-std=c++17', '-O2', '-Wall', '-Wextra', '-Werror', '-I', includes, fixture, '-o', executable,
  ], { encoding: 'utf8', timeout: 30000 })
  assert.equal(compile.status, 0, compile.stderr || compile.error?.message)
})

after(() => fs.rmSync(directory, { recursive: true, force: true }))

function invoke(...args) {
  const result = spawnSync(executable, args.map(String), { encoding: 'utf8', timeout: 30000 })
  assert.equal(result.status, 0, result.stderr || result.error?.message)
  return result.stdout.trim()
}

function words(values) {
  const bytes = Buffer.alloc(values.length * 4)
  for (let index = 0; index < values.length; index++) bytes.writeUInt32LE(values[index] >>> 0, index * 4)
  return bytes
}

// This decoder uses the wire-format contract, independently of the native encoder.
function decode(packed, expectedLength) {
  const bytes = Buffer.alloc(expectedLength)
  const tokens = []
  let source = 0
  let destination = 0
  while (source < packed.length) {
    assert.ok(source + 4 <= packed.length, 'truncated token')
    const token = packed.readUInt32LE(source)
    source += 4
    const count = token & 0x7fffffff
    const run = (token & 0x80000000) !== 0
    assert.ok(count > 0, 'zero-length token')
    const byteLength = count * 4
    assert.ok(destination + byteLength <= expectedLength, 'token exceeds declared output length')
    const payloadLength = run ? 4 : byteLength
    assert.ok(source + payloadLength <= packed.length, 'truncated payload')
    if (run) bytes.fill(packed.subarray(source, source + 4), destination, destination + byteLength)
    else packed.copy(bytes, destination, source, source + byteLength)
    tokens.push({ run, count })
    source += payloadLength
    destination += byteLength
  }
  assert.equal(destination, expectedLength, 'output does not match declared length')
  return { bytes, tokens }
}

function pack(name, bytes, { offset = 0 } = {}) {
  const rawPath = path.join(fixtureDirectory, `${name}.raw`)
  const packedPath = path.join(fixtureDirectory, `${name}.rle`)
  const metadataPath = path.join(fixtureDirectory, `${name}.json`)
  fs.writeFileSync(rawPath, bytes)
  invoke('pack', rawPath, packedPath, metadataPath, offset)
  const packed = fs.readFileSync(packedPath)
  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'))
  const decoded = decode(packed, bytes.length)
  assert.deepEqual(decoded.bytes, bytes, `${name}: decoded bytes must be bit exact`)
  assert.equal(metadata.originalByteLength, bytes.length)
  assert.equal(metadata.packedByteLength, packed.length)
  assert.equal(metadata.base64, packed.toString('base64'), `${name}: Base64 must match Node Buffer`)
  assert.deepEqual(Buffer.from(metadata.base64, 'base64'), packed)
  metadata.name = name
  metadata.rawSha256 = createHash('sha256').update(bytes).digest('hex')
  metadata.packedSha256 = createHash('sha256').update(packed).digest('hex')
  metadata.tokens = decoded.tokens
  fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`)
  return { packed, metadata, tokens: decoded.tokens }
}

function gate(originalLength, packedLength) {
  return JSON.parse(invoke('gate', originalLength, packedLength))
}

function seededBytes(length) {
  const bytes = Buffer.alloc(length)
  let seed = 0x352c0ffe
  for (let index = 0; index < length; index++) {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    bytes[index] = seed & 0xff
  }
  return bytes
}

test('the native size limits match the negotiated format', () => {
  assert.deepEqual(JSON.parse(invoke('constants')), { minBytes, maxBytes })
})

test('empty input emits no token and a single word emits one literal', () => {
  assert.deepEqual(JSON.parse(invoke('probe', 0, 'null')), { exception: null, packedBytes: 0 })
  const { packed, metadata, tokens } = pack('single-word', words([0xfe0180ff]))
  assert.deepEqual(packed, Buffer.from('01000000ff8001fe', 'hex'))
  assert.deepEqual(tokens, [{ run: false, count: 1 }])
  assert.equal(metadata.eligible, false)
})

test('runs of two stay literal and runs of three use a run token', () => {
  const { packed, tokens } = pack('runs-2-3', words([0x12345678, 0x12345678, 0xfedcba98, 0xfedcba98, 0xfedcba98]))
  assert.deepEqual(tokens, [{ run: false, count: 2 }, { run: true, count: 3 }])
  assert.deepEqual(packed, Buffer.from('0200000078563412785634120300008098badcfe', 'hex'))
})

test('adjacent short repeats and distinct words merge into one literal', () => {
  const { tokens } = pack('literal-merge', words([1, 1, 2, 3, 3, 4, 4, 4, 5, 6, 6]))
  assert.deepEqual(tokens, [{ run: false, count: 5 }, { run: true, count: 3 }, { run: false, count: 3 }])
})

test('multiple color blocks produce little-endian run tokens without empty literals', () => {
  const bytes = Buffer.alloc(256 * 1024)
  const colors = [Buffer.from([0xff, 0, 0, 0xff]), Buffer.from([0, 0xff, 0, 0x80]), Buffer.from([0, 0, 0xff, 0])]
  const splits = [0, 64 * 1024, 192 * 1024, bytes.length]
  for (let index = 0; index < colors.length; index++) bytes.fill(colors[index], splits[index], splits[index + 1])
  const { packed, metadata, tokens } = pack('color-blocks', bytes)
  assert.equal(packed.length, 24)
  assert.deepEqual(tokens, [{ run: true, count: 16384 }, { run: true, count: 32768 }, { run: true, count: 16384 }])
  assert.equal(packed.readUInt32LE(0), 0x80004000)
  assert.deepEqual(packed.subarray(4, 8), colors[0])
  assert.equal(metadata.eligible, true)
})

test('a changing gradient remains one literal and fails the compression gate', () => {
  const bytes = Buffer.alloc(256 * 1024)
  for (let offset = 0; offset < bytes.length; offset += 4) bytes.writeUInt32LE(offset / 4, offset)
  const { packed, metadata, tokens } = pack('gradient', bytes)
  assert.deepEqual(tokens, [{ run: false, count: bytes.length / 4 }])
  assert.equal(packed.length, bytes.length + 4)
  assert.equal(metadata.eligible, false)
})

test('all 256 byte values survive native packing and Base64 encoding', () => {
  const bytes = Buffer.alloc(minBytes)
  for (let index = 0; index < bytes.length; index++) bytes[index] = index & 0xff
  const { metadata, tokens } = pack('all-256', bytes)
  assert.deepEqual(tokens, [{ run: false, count: minBytes / 4 }])
  assert.equal(metadata.eligible, false)
})

test('deterministic random bytes round trip without accidental eligibility', () => {
  const { metadata } = pack('random', seededBytes(128 * 1024))
  assert.equal(metadata.eligible, false)
})

test('exactly 64KiB of one color meets the minimum size gate', () => {
  const { packed, metadata, tokens } = pack('min-size', Buffer.alloc(minBytes, 0xA5))
  assert.equal(packed.length, 8)
  assert.deepEqual(tokens, [{ run: true, count: minBytes / 4 }])
  assert.equal(metadata.eligible, true)
})

test('exactly 32MiB is accepted without truncating the run count', () => {
  const { packed, metadata, tokens } = pack('max-size', Buffer.alloc(maxBytes, 0x7F))
  assert.equal(packed.length, 8)
  assert.deepEqual(tokens, [{ run: true, count: maxBytes / 4 }])
  assert.equal(packed.readUInt32LE(0), 0x80800000)
  assert.equal(metadata.eligible, true)
})

test('unaligned source addresses preserve little-endian bytes', () => {
  const bytes = Buffer.concat([words([0x80ff0001, 0x80ff0001, 0x80ff0001]), seededBytes(minBytes - 12)])
  const aligned = pack('aligned', bytes)
  for (const offset of [1, 2, 3]) {
    const unaligned = pack(`unaligned-${offset}`, bytes, { offset })
    assert.deepEqual(unaligned.packed, aligned.packed)
  }
})

test('NaN, signed zero and high-bit patterns retain their exact bits', () => {
  const values = [0x7fc00001, 0x7f800001, 0xffc12345, 0, 0x80000000, 0xffffffff, 0x80000001]
  const bytes = Buffer.concat([words(values), words(Array(16384).fill(0x7fc00001)), words(values.reverse())])
  const { metadata } = pack('bit-exact', bytes)
  assert.equal(metadata.eligible, true)
})

test('non-word lengths and non-empty null sources reject with invalid_argument', () => {
  for (const length of [1, 2, 3, 5, minBytes - 1, minBytes + 1]) {
    assert.deepEqual(JSON.parse(invoke('probe', length, 'buffer')), { exception: 'invalid_argument' })
  }
  for (const length of [4, minBytes]) {
    assert.deepEqual(JSON.parse(invoke('probe', length, 'null')), { exception: 'invalid_argument' })
  }
})

test('inputs above 32MiB reject with length_error before encoding', () => {
  assert.deepEqual(JSON.parse(invoke('probe', maxBytes + 4, 'buffer')), { exception: 'length_error' })
})

test('the eligibility gate enforces size, alignment, non-empty output and exact 75% ratio', () => {
  const cases = [
    [0, 0, false], [minBytes - 4, 8, false], [minBytes, 8, true],
    [minBytes, 0, false], [minBytes, minBytes * 3 / 4, true], [minBytes, minBytes * 3 / 4 + 1, false],
    [minBytes + 4, 49155, true], [minBytes + 4, 49156, false], [minBytes + 1, 8, false],
    [maxBytes, 8, true], [maxBytes, maxBytes * 3 / 4, true], [maxBytes, maxBytes * 3 / 4 + 1, false],
    [maxBytes + 4, 8, false], [BigInt('18446744073709551615'), 8, false],
  ]
  for (const [originalLength, packedLength, expected] of cases) {
    assert.equal(gate(originalLength, packedLength), expected, `${originalLength} raw bytes, ${packedLength} packed bytes`)
  }
})

test('native Base64 matches Node Buffer for every padding length and binary byte value', () => {
  const samples = [Buffer.alloc(0), Buffer.from([0]), Buffer.from([0xff, 0x80]), Buffer.from([0, 0xff, 0x80]),
    Buffer.from([0, 0xff, 0x80, 0x01]), Buffer.from(Array.from({ length: 256 }, (_, index) => index)),
    seededBytes(257), seededBytes(258), seededBytes(259)]
  for (let index = 0; index < samples.length; index++) {
    const rawPath = path.join(directory, `base64-${index}.raw`)
    const encodedPath = path.join(directory, `base64-${index}.txt`)
    fs.writeFileSync(rawPath, samples[index])
    invoke('base64', rawPath, encodedPath)
    const encoded = fs.readFileSync(encodedPath, 'utf8')
    assert.equal(encoded, samples[index].toString('base64'))
    assert.deepEqual(Buffer.from(encoded, 'base64'), samples[index])
  }
})
