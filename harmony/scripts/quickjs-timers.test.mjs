import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, test } from 'node:test'

const root = fileURLToPath(new URL('../../', import.meta.url))
let directory
let addon
before(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dimina-timers-'))
  const native = path.join(root, 'harmony/dimina/src/main/cpp')
  const source = process.env.DIMINA_TIMER_SOURCE ?? path.join(native, 'types/qjs_extension/settimeout.c')
  const headers = process.env.NODE_INCLUDE_DIR ?? path.resolve(process.execPath, '../../include/node')
  fs.writeFileSync(path.join(directory, 'CMakeLists.txt'), `
cmake_minimum_required(VERSION 3.22)
project(timer_test C CXX)
include("${root}/cmake/DiminaQuickJS.cmake")
add_library(timer_test MODULE "${fileURLToPath(new URL('./fixtures/quickjs-timers.cpp', import.meta.url))}" "${source}")
target_compile_features(timer_test PRIVATE cxx_std_17)
target_compile_options(timer_test PRIVATE -UNDEBUG)
target_include_directories(timer_test PRIVATE "${native}" "${headers}")
set_source_files_properties("${source}" PROPERTIES COMPILE_DEFINITIONS "calloc=dimina_test_calloc;free=dimina_test_free")
set_target_properties(timer_test PROPERTIES PREFIX "" SUFFIX ".node")
if(APPLE)
  target_link_options(timer_test PRIVATE "-undefined" "dynamic_lookup")
endif()
dimina_configure_quickjs(timer_test ENABLE_DEBUGGER OFF)
`)
  const cmake = process.env.CMAKE ?? 'cmake'
  const build = path.join(directory, 'build')
  for (const args of [['-S', directory, '-B', build, '-DCMAKE_BUILD_TYPE=Release'], ['--build', build, '-j', '4']]) {
    const result = spawnSync(cmake, args, { encoding: 'utf8' })
    assert.equal(result.status, 0, result.error?.message || result.stdout + result.stderr)
  }
  addon = path.join(build, 'timer_test.node')
})
after(() => { if (directory) fs.rmSync(directory, { recursive: true, force: true }) })

const cases = [
  ['completed timeout releases its closure, registry entry and libuv handle', `
    let called = 0;
    (function () { const data = trackedBuffer(); setTimeout(() => { called++; assert(new Uint8Array(data).length === 1048576, 'callback data'); }, 0); })();
  `, `assert(called === 1, 'timeout must fire once'); assert(Object.keys(globalTimerMap).length === 0, 'completed timeout remained in registry');`, 'tracked'],
  ['cancelled timeouts release callback arguments and handles', `
    let called = 0;
    const id = setTimeout(() => called++, 10, {value: 1});
    clearInterval(id); clearTimeout(id); clearTimeout(); clearInterval(undefined);
  `, `assert(called === 0, 'cancelled timeout fired'); assert(Object.keys(globalTimerMap).length === 0, 'cancelled timeout remained in registry');`, ''],
  ['interval clears itself safely while its arguments remain readable', `
    let called = 0;
    let id = setInterval((data) => { if (++called === 3) clearTimeout(id); assert(data.value === 42, 'argument was released during callback'); }, 1, {value: 42});
  `, `assert(called === 3, 'interval cancellation'); assert(Object.keys(globalTimerMap).length === 0, 'interval remained in registry');`, ''],
  ['zero-delay interval repeats until cancelled', `
    let called = 0;
    const id = setInterval(() => { if (++called === 3) clearInterval(id); }, 0);
  `, `assert(called === 3, 'zero-delay interval stopped after first callback');`, ''],
  ['interval waits for its requested first delay', `
    let elapsed = 0; const started = Date.now();
    const id = setInterval(() => { elapsed = Date.now() - started; clearInterval(id); }, 25);
  `, `assert(elapsed >= 20, 'interval fired immediately instead of waiting for its delay');`, ''],
  ['Promise jobs finish before the following timer callback', `
    let order = [];
    setTimeout(() => { order.push(1); Promise.resolve().then(() => order.push(2)); }, 0);
    setTimeout(() => order.push(3), 0);
  `, `assert(order.join(',') === '1,2,3', 'timer microtask ordering');`, ''],
  ['bulk teardown from an active callback cancels remaining callbacks', `
    let called = 0;
    setTimeout(() => { called++; clearAll(); }, 0);
    setTimeout(() => { throw Error('timer survived teardown'); }, 20);
  `, `assert(called === 1, 'teardown callback'); assert(Object.keys(globalTimerMap).length === 0, 'teardown retained timers');`, ''],
  ['initializing another runtime does not change existing timer class identity', `
    let called = 0; const id = setTimeout(() => called++, 1);
  `, `assert(called === 0, 'timer cancellation broke after second runtime init'); assert(Object.keys(globalTimerMap).length === 0, 'old runtime retained timer');`, 'second-runtime'],
  ['high-frequency one-shot polling returns the registry to empty', `
    let count = 0;
    function poll() { if (++count < 500) setTimeout(poll, 0); }
    setTimeout(poll, 0);
  `, `assert(count === 500, 'poll count'); assert(Object.keys(globalTimerMap).length === 0, 'one-shot polling accumulated timer records');`, ''],
]

for (const [name, source, verify, mode] of cases) {
  test(name, () => {
    const script = `require(${JSON.stringify(addon)}).run(${JSON.stringify(source)}, ${JSON.stringify(verify)}, ${JSON.stringify(mode)})`
    const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 10000 })
    assert.equal(result.status, 0, result.error?.message || result.stdout + result.stderr)
  })
}
