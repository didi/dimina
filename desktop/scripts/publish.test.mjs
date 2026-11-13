import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { crateUploadBody, publishAssets, publishCargo, publishNpm, releaseVersion, requestJSON } from './publish.mjs'

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'dimina-publish-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}
const response = (data, status = 200) => new Response(JSON.stringify(data), { status })

test('release tag parsing rejects injection and invalid SemVer', () => {
  assert.equal(releaseVersion('v1.9.0-beta.1'), '1.9.0-beta.1')
  for (const tag of ['v01.0.0', 'v1.2.3-01', 'v1.2.3/other', 'v1.2.3;echo', 'v1.2.3+build', 'v1.2.3\n']) assert.throws(() => releaseVersion(tag))
})

test('registry outages and authentication failures are never treated as missing versions', async () => {
  assert.equal(await requestJSON('https://example.test/package', {}, async () => response({}, 404)), null)
  for (const status of [401, 403, 429, 500]) await assert.rejects(requestJSON('https://example.test/package', {}, async () => response({}, status)), new RegExp(String(status)))
  await assert.rejects(requestJSON('https://example.test/package', { method: 'PUT' }, async () => response({}, 404)), /404/)
  await assert.rejects(requestJSON('https://example.test/package', {}, async () => response({ errors: [{ detail: 'invalid package' }] })), /invalid package/)
})

test('npm publishes the checked tarball to next for prereleases', async t => {
  const directory = fixture(t), calls = []
  writeFileSync(join(directory, 'dimina-desktop-sdk-1.9.0-beta.1.tgz'), 'verified tarball')
  await publishNpm(directory, '1.9.0-beta.1', { fetchFn: async () => response({}, 404), runFn: (...args) => calls.push(args) })
  assert.equal(calls[0][0], 'npm')
  assert.ok(calls[0][1].includes('--provenance'))
  assert.equal(calls[0][1][calls[0][1].indexOf('--tag') + 1], 'next')
})

test('npm duplicate handling skips identical packages and rejects conflicting versions', async t => {
  const directory = fixture(t), bytes = Buffer.from('verified tarball')
  writeFileSync(join(directory, 'dimina-desktop-sdk-1.9.0.tgz'), bytes)
  const integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64')
  let published = false
  await publishNpm(directory, '1.9.0', { fetchFn: async () => response({ dist: { integrity } }), runFn: () => { published = true } })
  assert.equal(published, false)
  await assert.rejects(publishNpm(directory, '1.9.0', { fetchFn: async () => response({ dist: { integrity: 'other' } }) }), /different content/)
})

test('Cargo framing contains UTF-8 metadata and the exact verified crate bytes', () => {
  const metadata = { name: 'tauri-plugin-dimina', vers: '1.9.0', description: '桌面 SDK' }, crate = Buffer.from([0, 1, 255, 3])
  const body = crateUploadBody(metadata, crate), length = body.readUInt32LE(0)
  assert.deepEqual(JSON.parse(body.subarray(4, 4 + length)), metadata)
  assert.equal(body.readUInt32LE(4 + length), crate.length)
  assert.deepEqual(body.subarray(8 + length), crate)
})

test('Cargo publishing uploads the verified artifact without rebuilding it', async t => {
  const directory = fixture(t), calls = [], bytes = Buffer.from('verified crate')
  writeFileSync(join(directory, 'tauri-plugin-dimina-1.9.0.crate'), bytes)
  writeFileSync(join(directory, 'tauri-plugin-dimina-1.9.0.metadata.json'), JSON.stringify({ name: 'tauri-plugin-dimina', vers: '1.9.0' }))
  await publishCargo(directory, '1.9.0', { token: 'test-only', fetchFn: async (url, options) => { calls.push([url, options]); return calls.length === 1 ? response({}, 404) : response({ warnings: {} }) } })
  assert.equal(calls[0][1].headers.Authorization, undefined)
  assert.equal(calls[1][0], 'https://crates.io/api/v1/crates/new')
  assert.equal(calls[1][1].headers.Authorization, 'test-only')
  assert.ok(calls[1][1].body.subarray(-bytes.length).equals(bytes))
  await assert.rejects(publishCargo(directory, '1.9.0', { fetchFn: async () => response({ version: { checksum: 'different' } }) }), /different content/)
})

test('Release asset conflicts fail before any upload and never clobber existing files', async t => {
  const directory = fixture(t), calls = []
  writeFileSync(join(directory, 'a-new.zip'), 'new')
  writeFileSync(join(directory, 'z-existing.zip'), 'different')
  await assert.rejects(publishAssets(directory, 'v1.9.0', {
    token: 'test-only', repository: 'didi/dimina', runFn: (...args) => calls.push(args),
    fetchFn: async url => url.includes('/assets?') ? response([{ name: 'z-existing.zip', digest: 'sha256:wrong' }]) : response({ id: 1 }),
  }), /different content/)
  assert.equal(calls.length, 0)
})

test('Release asset retries retain matching files and upload only missing assets', async t => {
  const directory = fixture(t), calls = [], bytes = Buffer.from('same')
  writeFileSync(join(directory, 'existing.zip'), bytes)
  writeFileSync(join(directory, 'new.zip'), 'new')
  const checksum = 'sha256:' + createHash('sha256').update(bytes).digest('hex')
  await publishAssets(directory, 'v1.9.0', {
    token: 'test-only', repository: 'didi/dimina', runFn: (...args) => calls.push(args),
    fetchFn: async url => url.includes('/assets?') ? response([{ name: 'existing.zip', digest: checksum }]) : response({ id: 1 }),
  })
  assert.equal(calls.length, 1)
  assert.ok(calls[0][1].includes(join(directory, 'new.zip')))
  assert.ok(!calls[0][1].includes(join(directory, 'existing.zip')))
  assert.ok(!calls[0][1].includes('--clobber'))
})

test('prerelease publishing marks an existing Release without promoting npm latest', async t => {
  const directory = fixture(t), calls = []
  await publishAssets(directory, 'v1.9.0-beta.1', {
    token: 'test-only', repository: 'didi/dimina',
    fetchFn: async (url, options) => {
      calls.push([url, options])
      return url.includes('/assets?') ? response([]) : response({ id: 1, prerelease: false })
    },
    runFn: () => assert.fail('No artifacts should be uploaded'),
  })
  const update = calls.find(([, options]) => options.method === 'PATCH')
  assert.equal(JSON.parse(update[1].body).prerelease, true)
  assert.equal(update[1].headers['Content-Type'], 'application/json')
})
