import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

test('real QuickJS collects unheld WebGL proxies, bounds dead names and preserves caller-held identity', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dimina-retired-buffer-'))
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const fixture = fileURLToPath(new URL('./fixtures/canvas-retired-buffer-gc.cpp', import.meta.url))
  const canvas = join(root, 'fe/packages/service/src/api/core/ui/canvas/canvas-node.js')
  const helper = process.env.DIMINA_RETIRED_BUFFER_HELPER ?? join(root, 'fe/packages/service/src/api/core/ui/canvas/retired-buffer-references.js')
  try {
    writeFileSync(join(directory, 'CMakeLists.txt'), `
cmake_minimum_required(VERSION 3.22)
project(retired_buffer_test C CXX)
include("${root}/cmake/DiminaQuickJS.cmake")
add_executable(retired_buffer "${fixture}")
target_compile_features(retired_buffer PRIVATE cxx_std_17)
dimina_configure_quickjs(retired_buffer ENABLE_DEBUGGER OFF SOURCE_PATCH "${root}/third_party/quickjs/patches/bridge-data.patch")
`)
    const cmake = process.env.CMAKE ?? 'cmake'
    for (const args of [
      ['-S', directory, '-B', join(directory, 'build'), '-DCMAKE_BUILD_TYPE=Release'],
      ['--build', join(directory, 'build'), '-j', '4'],
    ]) {
      const result = spawnSync(cmake, args, { encoding: 'utf8', timeout: 120000 })
      assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message)
    }
    const result = spawnSync(join(directory, 'build', 'retired_buffer'), [helper, canvas], { encoding: 'utf8', timeout: 10000 })
    assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message)
    assert.match(result.stdout, /Actual QuickJS retired-buffer GC\/lifetime\/owner-dispose passed/)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
