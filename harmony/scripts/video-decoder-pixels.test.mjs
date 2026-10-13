import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dimina-video-pixels-'))
const executable = path.join(directory, 'video-decoder-pixels')

before(() => {
  const native = fileURLToPath(new URL('../dimina/src/main/cpp/', import.meta.url))
  // An optional isolated header copy supports ablations without touching production files.
  if (process.env.DIMINA_VIDEO_PIXELS_HEADER) {
    fs.copyFileSync(process.env.DIMINA_VIDEO_PIXELS_HEADER, path.join(directory, 'video_decoder_pixels.h'))
  }
  const fixture = fileURLToPath(new URL('./fixtures/video-decoder-pixels.cpp', import.meta.url))
  const compiler = process.env.CXX ?? 'c++'
  const flags = ['-std=c++17', '-O3', '-Wall', '-Wextra', '-Werror']
  if (process.arch === 'arm64') flags.push('-march=armv8-a')
  const compile = spawnSync(compiler, [...flags, '-I', directory, '-I', native, fixture, '-o', executable], {
    encoding: 'utf8', timeout: 30000,
  })
  assert.equal(compile.status, 0, compile.error?.message || compile.stderr)
})

after(() => fs.rmSync(directory, { recursive: true, force: true }))

for (const [name, description, expectedCases] of [
  ['cube', 'production pixel core and scalar fallback match the original formula for every YUV byte triple in four variants', 67108864],
  ['shapes', '11520 shapes preserve crop, stride, unaligned buffers, canaries and byte exact output', 11520],
  ['golden', 'full range BT601 preserves the original byte and ARM64 FMA green 108 for Y35 U135 V21', 4],
  ['empty', 'zero width or height leaves the entire output unchanged', 3],
]) {
  test(description, () => {
    const result = spawnSync(executable, [name], { encoding: 'utf8', timeout: 60000 })
    assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout)
    const report = JSON.parse(result.stdout)
    assert.equal(report.cases, expectedCases)
    assert.equal(report.mismatchBytes, 0)
    assert.equal(report.fastMath, false)
    assert.equal(typeof report.neonEnabled, 'boolean')
    assert.equal(report.roundingMode, 'FE_TONEAREST')
  })
}
