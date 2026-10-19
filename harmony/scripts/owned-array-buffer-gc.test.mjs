import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
const root = fileURLToPath(new URL('../../', import.meta.url))
const patch = process.env.DIMINA_QUICKJS_PATCH ?? path.join(root, 'third_party/quickjs/patches/bridge-data.patch')
const fixture = fileURLToPath(new URL('./fixtures/owned-array-buffer-gc.cpp', import.meta.url))
for (const debug of [false, true]) {
  test(`owned ArrayBuffer adoption collects once and preserves allocation failures in ${debug ? 'Debug' : 'Release'}`, () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dimina-owned-gc-'))
    try {
      if (process.env.DIMINA_VIDEO_FRAME_HEADER) fs.copyFileSync(process.env.DIMINA_VIDEO_FRAME_HEADER, path.join(directory, 'video_decoder_frame.h'))
      fs.writeFileSync(path.join(directory, 'CMakeLists.txt'), `
cmake_minimum_required(VERSION 3.22)
project(owned_gc_test C CXX)
include("${root}/cmake/DiminaQuickJS.cmake")
add_executable(owned_gc "${fixture}")
target_compile_features(owned_gc PRIVATE cxx_std_17)
target_include_directories(owned_gc PRIVATE "${directory}" "${root}/harmony/dimina/src/main/cpp")
# Test-only upstream diagnostics count real collector runs; no production hook.
target_compile_definitions(owned_gc PRIVATE DUMP_GC)
dimina_configure_quickjs(owned_gc ENABLE_DEBUGGER ${debug ? 'ON' : 'OFF'} SOURCE_PATCH "${patch}")
`)
      const cmake = process.env.CMAKE ?? 'cmake', build = path.join(directory, 'build')
      for (const args of [['-S', directory, '-B', build, '-DCMAKE_BUILD_TYPE=Release'], ['--build', build, '-j', '4']]) {
        const result = spawnSync(cmake, args, { encoding: 'utf8' })
        assert.equal(result.status, 0, result.error?.message || result.stdout + result.stderr)
      }
      const run = spawnSync(path.join(build, 'owned_gc'), [], { encoding: 'utf8', timeout: 10000 })
      assert.equal(run.status, 0, run.error?.message || run.stderr)
      const adoption = run.stdout.split('BEGIN_ADOPTION\n')[1]?.split('END_ADOPTION')[0]
      assert.ok(adoption !== undefined, 'fixture must delimit the actual adoption')
      assert.equal(adoption.split('\n').filter(line => line.startsWith('GC:')).length, 1,
        'one external allocation must not immediately trigger a second full collection')
      assert.ok(run.stdout.includes('ALL_33_ALLOCATION_BUDGET_BOUNDARIES_PASS'))
      const frame = run.stdout.split('BEGIN_FRAME\n')[1]?.split('END_FRAME')[0]
      assert.ok(frame !== undefined, 'fixture must exercise the actual native frame converter')
      assert.equal(frame.split('\n').filter(line => line.startsWith('GC:')).length, 1, 'one complete frame conversion must not collect for each result object and buffer')
      assert.ok(run.stdout.includes('POST_FAILURE_CYCLE_COLLECTION_PASS'))
      assert.ok(run.stdout.includes('POST_SUCCESS_RELEASE_CYCLE_COLLECTION_PASS'))
      const steady = run.stdout.split('BEGIN_STEADY_FRAMES\n')[1]?.split('END_STEADY_FRAMES')[0]
      assert.ok(steady !== undefined, 'fixture must exercise complete steady frame conversions')
      assert.equal(steady.split('\n').filter(line => line.startsWith('GC:')).length, 0, 'fixed-size frames within the learned bounded peak must not force collection on every allocation')
      const manual = run.stdout.split('BEGIN_MANUAL_POLICY\n').slice(1).map(value => value.split('END_MANUAL_POLICY')[0])
      assert.equal(manual.length, 3)
      for (const scope of manual) assert.equal(scope.split('\n').filter(line => line.startsWith('GC:')).length, 0, 'owned buffer release must preserve explicit GC thresholds')
    } finally { fs.rmSync(directory, { recursive: true, force: true }) }
  })
}
