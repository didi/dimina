import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
const output = mkdtempSync(join(tmpdir(), 'dimina-canvas-ui-'))
const binary = join(output, 'channel')
const build = spawnSync('clang++', ['-std=c++17', '-O2', '-pthread', '-Wall', '-Wextra', '-Werror',
  '-I', fileURLToPath(new URL('../dimina/src/main/cpp', import.meta.url)),
  fileURLToPath(new URL('./fixtures/canvas-ui-channel.cpp', import.meta.url)), '-o', binary], { encoding: 'utf8' })
assert.equal(build.status, 0, build.stderr)
for (const name of ['fifo', 'cancel', 'timeout', 'failed-post', 'owned', 'budget', 'isolation', 'concurrent']) {
  test(`native canvas UI channel: ${name}`, () => {
    const result = spawnSync(binary, [name], { encoding: 'utf8', timeout: 5000 })
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.match(result.stdout, /PASS/)
  })
}
process.on('exit', () => rmSync(output, { recursive: true, force: true }))
