import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = fileURLToPath(new URL('../../', import.meta.url))
function fixture(t, referenceEol, manifestEol) {
  const directory = mkdtempSync(join(tmpdir(), 'dimina api manifest '))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  writeFileSync(join(directory, 'package.json'), '{"type":"module"}')
  for (const file of ['desktop/scripts/sync-mobile-apis.mjs', 'fe/packages/compiler/src/common/compatibility-reference.js', 'docs/API-Reference.md', 'desktop/mobile_api_names.json']) {
    const destination = join(directory, file)
    mkdirSync(dirname(destination), { recursive: true })
    const eol = file.endsWith('.json') ? manifestEol : referenceEol
    writeFileSync(destination, readFileSync(join(root, file), 'utf8').replace(/\r?\n/g, eol))
  }
  return {
    manifest: join(directory, 'desktop/mobile_api_names.json'),
    run: (...args) => spawnSync(process.execPath, [join(directory, 'desktop/scripts/sync-mobile-apis.mjs'), ...args], { encoding: 'utf8' }),
  }
}

for (const [sourceName, referenceEol] of [['LF', '\n'], ['CRLF', '\r\n']]) {
  for (const [manifestName, manifestEol] of [['LF', '\n'], ['CRLF', '\r\n']]) {
    test(`accepts an up-to-date manifest with ${sourceName} sources and ${manifestName} output`, t => {
      const { run, manifest } = fixture(t, referenceEol, manifestEol)
      const before = readFileSync(manifest)
      const result = run('--check')
      assert.equal(result.status, 0, result.stderr)
      assert.deepEqual(readFileSync(manifest), before, '--check must not rewrite the manifest')
    })
  }
}

for (const [name, eol] of [['LF', '\n'], ['CRLF', '\r\n']]) {
  test(`rejects genuinely stale ${name} manifests and regenerates canonical LF output`, t => {
    const { run, manifest } = fixture(t, eol, eol)
    const original = readFileSync(manifest, 'utf8').replace(/\r\n/g, '\n')
    const names = JSON.parse(original)
    names.pop()
    writeFileSync(manifest, (JSON.stringify(names, null, 2) + '\n').replace(/\n/g, eol))
    const stale = run('--check')
    assert.notEqual(stale.status, 0)
    assert.match(stale.stderr, /Mobile API manifest is stale/)
    const generated = run()
    assert.equal(generated.status, 0, generated.stderr)
    assert.equal(readFileSync(manifest, 'utf8'), original)
    assert.equal(run('--check').status, 0)
  })
}
