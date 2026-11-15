import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { prepareRelease } from './prepare-release.mjs'

function fixture(t, coreVersion = '1.9.0', adapterVersion = coreVersion, dependency = coreVersion) {
  const root = mkdtempSync(join(tmpdir(), 'dimina-harmony-release-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const core = join(root, 'harmony/dimina/oh-package.json5')
  const adapter = join(root, 'harmony/map_amap/oh-package.json5')
  mkdirSync(join(root, 'harmony/dimina'), { recursive: true })
  mkdirSync(join(root, 'harmony/map_amap'), { recursive: true })
  writeFileSync(core, JSON.stringify({ name: '@example/core', version: coreVersion, description: 'preserve me' }))
  writeFileSync(adapter, JSON.stringify({ version: adapterVersion, dependencies: { '@example/core': dependency, other: '2' } }))
  const changelogs = ['dimina', 'map_amap'].map(module => join(root, `harmony/${module}/CHANGELOG.md`))
  for (const path of changelogs) writeFileSync(path, `# Changelog\n\n## [v${coreVersion}] 2026-11-13\n\n- Existing release notes.\n`)
  return { root, core, adapter, changelogs, bytes: () => [core, adapter, ...changelogs].map(path => readFileSync(path, 'utf8')) }
}

test('stable and already prepared prerelease versions retain their original manifests', t => {
  for (const version of ['1.9.0', '1.9.0-beta.1']) {
    const f = fixture(t, version), before = f.bytes()
    assert.equal(prepareRelease(f.root, `v${version}`), version)
    assert.deepEqual(f.bytes(), before)
  }
})

test('a prerelease of the source base updates both packages and the exact dependency', t => {
  const f = fixture(t)
  assert.equal(prepareRelease(f.root, 'v1.9.0-beta.1'), '1.9.0-beta.1')
  assert.deepEqual(JSON.parse(readFileSync(f.core, 'utf8')), { name: '@example/core', version: '1.9.0-beta.1', description: 'preserve me' })
  assert.deepEqual(JSON.parse(readFileSync(f.adapter, 'utf8')), { version: '1.9.0-beta.1', dependencies: { '@example/core': '1.9.0-beta.1', other: '2' } })
})

test('mismatched bases, stable tags and source dependencies fail before any manifest is written', t => {
  for (const [core, adapter, dependency, tag] of [
    ['1.9.0', '1.9.0', '1.9.0', 'v1.9.1'],
    ['1.9.0', '1.9.0', '1.9.0', 'v1.9.1-beta.1'],
    ['1.9.0', '1.9.1', '1.9.0', 'v1.9.0-beta.1'],
    ['1.9.0', '1.9.0', '1.8.2', 'v1.9.0-beta.1'],
  ]) {
    const f = fixture(t, core, adapter, dependency), before = f.bytes()
    assert.throws(() => prepareRelease(f.root, tag), /match/)
    assert.deepEqual(f.bytes(), before)
  }
})

test('invalid tags are rejected without modifying source manifests', t => {
  const f = fixture(t), before = f.bytes()
  for (const tag of ['1.9.0', 'v01.9.0', 'v1.9.0-01', 'v1.9.0-beta.01', 'v1.9.0+local', 'v1.9.0/other', 'v1.9.0\n']) {
    assert.throws(() => prepareRelease(f.root, tag), /SemVer/)
    assert.deepEqual(f.bytes(), before)
  }
})

test('already versioned prereleases gain exact changelog entries for both HARs once', t => {
  const f = fixture(t, '1.9.0-beta.1')
  const previous = '# Changelog\n\n## [v1.9.0] 2026-11-13\n\n- Existing release notes.\n'
  for (const path of f.changelogs) writeFileSync(path, previous)
  const manifests = f.bytes().slice(0, 2)
  prepareRelease(f.root, 'v1.9.0-beta.1')
  for (const path of f.changelogs) {
    const content = readFileSync(path, 'utf8')
    assert.match(content, /^## \[v1\.9\.0-beta\.1\]$/m)
    assert.ok(content.endsWith(previous.slice(previous.indexOf('## [v1.9.0]'))))
  }
  assert.deepEqual(f.bytes().slice(0, 2), manifests)
  const prepared = f.bytes()
  prepareRelease(f.root, 'v1.9.0-beta.1')
  assert.deepEqual(f.bytes(), prepared)
})

test('missing stable or prerelease base notes fail before changing either package', t => {
  for (const tag of ['v1.9.0', 'v1.9.0-beta.1']) {
    const f = fixture(t)
    writeFileSync(f.changelogs[1], '# Changelog\n\n## [v1.8.2]\n\n- Earlier notes.\n')
    const before = f.bytes()
    assert.throws(() => prepareRelease(f.root, tag), /changelog must contain/)
    assert.deepEqual(f.bytes(), before)
  }
})
