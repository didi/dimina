import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { before, after, test } from 'node:test'

const root = fileURLToPath(new URL('../../', import.meta.url))
let directory, executable
before(() => {
  directory = mkdtempSync(join(tmpdir(), 'dimina-pag-scheduler-'))
  const fixture = fileURLToPath(new URL('./fixtures/libpag-async-lifetime.cpp', import.meta.url))
  writeFileSync(join(directory, 'CMakeLists.txt'), `
cmake_minimum_required(VERSION 3.22)
project(buffer_lifetime C CXX)
include("${root}/cmake/DiminaQuickJS.cmake")
add_executable(buffer_lifetime "${fixture}")
target_compile_features(buffer_lifetime PRIVATE cxx_std_17)
dimina_configure_quickjs(buffer_lifetime ENABLE_DEBUGGER OFF SOURCE_PATCH "${root}/third_party/quickjs/patches/bridge-data.patch")
`)
  const cmake = process.env.CMAKE ?? 'cmake'
  for (const args of [
    ['-S', directory, '-B', join(directory, 'build'), '-DCMAKE_BUILD_TYPE=Release'],
    ['--build', join(directory, 'build'), '-j', '4'],
  ]) {
    const result = spawnSync(cmake, args, { encoding: 'utf8', timeout: 120000 })
    assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message)
  }
  executable = join(directory, 'build', 'buffer_lifetime')
})
after(() => { if (directory) rmSync(directory, { recursive: true, force: true }) })
for (const mode of ['flush', 'internal']) {
  test(`real QuickJS releases actual PAG Player/Queue scheduling callbacks before GC: ${mode}`, () => {
    const canvas = process.env.DIMINA_ASYNC_BUFFER_SOURCE ?? join(root, 'fe/packages/service/src/api/core/ui/canvas/canvas-node.js')
    const player = process.env.DIMINA_LIBPAG_SOURCE ?? join(root, 'examples/miniprogram/base/miniprogram_npm/libpag-miniprogram/index.js')
    const result = spawnSync(executable, [canvas, player, mode], { encoding: 'utf8', timeout: 10000 })
    assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message)
    assert.match(result.stdout, /PASS actual PAG schedulers release callbacks before cycle GC/)
  })
}
