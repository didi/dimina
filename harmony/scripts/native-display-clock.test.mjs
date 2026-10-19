import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
const root = fileURLToPath(new URL('../../', import.meta.url))
const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url))
for (const fixture of ['native-display-clock', 'native-message-sink']) {
  test(fixture + ' preserves real callback ownership and teardown', () => {
    const output = mkdtempSync(join(tmpdir(), 'dimina-display-clock-'))
    try {
      const binary = join(output, fixture)
      const compile = spawnSync(process.env.CXX ?? 'c++', ['-std=c++17', '-O2', '-UNDEBUG', '-pthread', '-Wall', '-Wextra', '-Werror',
        '-I', root, '-I', join(root, 'harmony/dimina/src/main/cpp'), '-I', join(fixtures, 'include'), join(fixtures, fixture + '.cpp'), '-o', binary], { encoding: 'utf8' })
      assert.equal(compile.status, 0, compile.stderr || compile.error?.message)
      const run = spawnSync(binary, [], { encoding: 'utf8', timeout: 5000 })
      assert.equal(run.status, 0, run.stdout + run.stderr)
      assert.match(run.stdout, /PASS/)
    } finally { rmSync(output, { recursive: true, force: true }) }
  })
}
