import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const root = fileURLToPath(new URL('../../', import.meta.url))
const patch = path.join(root, 'third_party/quickjs/patches/bridge-data.patch')
const fixture = fileURLToPath(new URL('./fixtures/quickjs-json.cpp', import.meta.url))
const values = [
  '', '\u0000\b\t\n\v\f\r\u001f"\\/',
  Array.from({ length: 256 }, (_, i) => String.fromCharCode(i)).join(''),
  Array.from({ length: 65536 }, (_, i) => String.fromCharCode(i)).join(''),
  '\ud800A\udfff\ud834\udf06', '😀中文\u2028\u2029',
  { wide: '中文', payload: 'AQID'.repeat(40000) },
  { base64: 'AZaz09+/='.repeat(50000), key: '"\u0000\\' },
  ['end\\', '"end', '\\"\\', '𠮷', null, true, 123],
  Object.fromEntries(['中文', '\u0000', '\\', '😀'].map(key => [key, 'AZaz09+/='.repeat(10000)])),
]

for (const debuggerEnabled of [false, true]) {
  test(`Harmony JSON overlay preserves escaping and OOM in ${debuggerEnabled ? 'Debug' : 'Release'}`, () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dimina-json-'))
    try {
      const source = [
        'function assert(ok, message) { if (!ok) throw new Error(message) }',
        ...values.map((value, index) => `assert(JSON.stringify(${JSON.stringify(value)}) === ${JSON.stringify(JSON.stringify(value))}, 'JSON parity ${index}');`),
        `let calls = []; const value = {get x(){calls.push('x');return '"\\\\中文'}, toJSON(key){calls.push('toJSON:'+key);return this}};
JSON.stringify(value, (key,v)=>{calls.push('replace:'+key);return v});
assert(calls.join('|') === 'toJSON:|replace:|x|replace:x|replace:toJSON', 'toJSON/replacer/getter ordering');
const cyclic = {}; cyclic.self = cyclic; let threw = false;
try { JSON.stringify(cyclic) } catch (error) { threw = error instanceof TypeError }
assert(threw, 'cyclic data must still throw');`,
      ].join('\n')
      fs.writeFileSync(path.join(directory, 'parity.js'), source)
      fs.writeFileSync(path.join(directory, 'CMakeLists.txt'), `
cmake_minimum_required(VERSION 3.22)
project(json_overlay_test C CXX)
include("${root}/cmake/DiminaQuickJS.cmake")
add_executable(json_overlay "${fixture}")
target_compile_features(json_overlay PRIVATE cxx_std_17)
dimina_configure_quickjs(json_overlay ENABLE_DEBUGGER ${debuggerEnabled ? 'ON' : 'OFF'} SOURCE_PATCH "${patch}")
`)
      const cmake = process.env.CMAKE ?? 'cmake'
      const build = path.join(directory, 'build')
      const configure = spawnSync(cmake, ['-S', directory, '-B', build, '-DCMAKE_BUILD_TYPE=Release'], { encoding: 'utf8' })
      assert.equal(configure.status, 0, configure.error?.message || configure.stdout + configure.stderr)
      const compile = spawnSync(cmake, ['--build', build, '-j', '4'], { encoding: 'utf8' })
      assert.equal(compile.status, 0, compile.error?.message || compile.stdout + compile.stderr)
      const run = spawnSync(path.join(build, 'json_overlay'), [path.join(directory, 'parity.js')], { encoding: 'utf8', timeout: 10000 })
      assert.equal(run.status, 0, run.error?.message || run.stderr)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
}
