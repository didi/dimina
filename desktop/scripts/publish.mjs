import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const headers = { 'User-Agent': 'dimina-desktop-release (https://github.com/didi/dimina)', Accept: 'application/json' }
const run = (command, args) => execFileSync(command, args, { stdio: 'inherit' })
const digest = (bytes, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding)

export function releaseVersion(tag) {
  const number = '(?:0|[1-9][0-9]*)'
  const identifier = `(?:${number}|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)`
  const match = new RegExp(`^v(${number}\\.${number}\\.${number}(?:-${identifier}(?:\\.${identifier})*)?)$`).exec(tag)
  if (!match || match[0] !== tag) throw new Error('Expected a SemVer release tag with v prefix')
  return match[1]
}

export async function requestJSON(url, options = {}, fetchFn = fetch) {
  const response = await fetchFn(url, { signal: AbortSignal.timeout(120_000), ...options, headers: { ...headers, ...options.headers } })
  if (response.status === 404 && (!options.method || options.method === 'GET')) return null
  if (!response.ok) throw new Error(`Registry request failed: ${response.status} ${new URL(url).pathname}`)
  const result = await response.json()
  if (result.errors?.length) throw new Error(`Registry rejected upload: ${result.errors.map(error => error.detail).join('; ')}`)
  return result
}

export async function publishNpm(directory, version, { fetchFn = fetch, runFn = run } = {}) {
  const file = join(directory, `dimina-desktop-sdk-${version}.tgz`)
  const bytes = readFileSync(file)
  const existing = await requestJSON(`https://registry.npmjs.org/@dimina%2fdesktop-sdk/${version}`, {}, fetchFn)
  if (existing) {
    if (existing.dist?.integrity !== `sha512-${digest(bytes, 'sha512', 'base64')}`) throw new Error('npm version already exists with different content')
    console.log(`npm ${version} already published with the same content`)
    return
  }
  runFn('npm', ['publish', file, '--access', 'public', '--provenance', '--tag', version.includes('-') ? 'next' : 'latest', '--registry', 'https://registry.npmjs.org'])
}

// Upload the exact .crate verified by cargo package, using Cargo's registry API:
// https://doc.rust-lang.org/cargo/reference/registry-web-api.html#publish
export function crateUploadBody(metadata, crate) {
  const json = Buffer.from(JSON.stringify(metadata))
  const jsonLength = Buffer.alloc(4), crateLength = Buffer.alloc(4)
  jsonLength.writeUInt32LE(json.length)
  crateLength.writeUInt32LE(crate.length)
  return Buffer.concat([jsonLength, json, crateLength, crate])
}

export async function publishCargo(directory, version, { fetchFn = fetch, token = process.env.CARGO_REGISTRY_TOKEN } = {}) {
  const crate = readFileSync(join(directory, `tauri-plugin-dimina-${version}.crate`))
  const metadata = JSON.parse(readFileSync(join(directory, `tauri-plugin-dimina-${version}.metadata.json`), 'utf8'))
  if (metadata.name !== 'tauri-plugin-dimina' || metadata.vers !== version) throw new Error('Cargo upload metadata does not match release')
  const existing = await requestJSON(`https://crates.io/api/v1/crates/tauri-plugin-dimina/${version}`, {}, fetchFn)
  if (existing) {
    if (existing.version?.checksum !== digest(crate)) throw new Error('Cargo version already exists with different content')
    console.log(`Cargo ${version} already published with the same content`)
    return
  }
  if (!token) throw new Error('Missing CARGO_REGISTRY_TOKEN')
  await requestJSON('https://crates.io/api/v1/crates/new', {
    method: 'PUT',
    headers: { Authorization: token, 'Content-Type': 'application/octet-stream' },
    body: crateUploadBody(metadata, crate),
  }, fetchFn)
  console.log(`Published tauri-plugin-dimina ${version}`)
}

export async function publishAssets(directory, tag, { fetchFn = fetch, runFn = run, repository = process.env.GITHUB_REPOSITORY, token = process.env.GH_TOKEN } = {}) {
  const version = releaseVersion(tag)
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '')) throw new Error('Missing or invalid GITHUB_REPOSITORY')
  if (!token) throw new Error('Missing GH_TOKEN')
  const api = `https://api.github.com/repos/${repository}/releases`
  const options = { headers: { Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' } }
  let release = await requestJSON(`${api}/tags/${tag}`, options, fetchFn)
  if (!release) {
    try {
      release = await requestJSON(api, { ...options, method: 'POST', headers: { ...options.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ tag_name: tag, name: tag, prerelease: version.includes('-') }) }, fetchFn)
    } catch (error) {
      // Changelog generation can create the same Release concurrently.
      release = await requestJSON(`${api}/tags/${tag}`, options, fetchFn)
      if (!release) throw error
    }
  }
  if (release.prerelease !== undefined && release.prerelease !== version.includes('-')) {
    await requestJSON(`${api}/${release.id}`, { ...options, method: 'PATCH', headers: { ...options.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ prerelease: version.includes('-') }) }, fetchFn)
  }
  const pending = []
  const existingAssets = await requestJSON(`${api}/${release.id}/assets?per_page=100`, options, fetchFn)
  for (const name of readdirSync(directory).sort()) {
    const file = join(directory, name)
    const existing = existingAssets.find(asset => asset.name === name)
    if (!existing) { pending.push(file); continue }
    let checksum = existing.digest
    if (!checksum) {
      const temporary = mkdtempSync(join(tmpdir(), 'dimina-release-'))
      try {
        runFn('gh', ['release', 'download', tag, '--repo', repository, '--pattern', name, '--dir', temporary])
        checksum = `sha256:${digest(readFileSync(join(temporary, name)))}`
      } finally { rmSync(temporary, { recursive: true, force: true }) }
    }
    if (checksum !== `sha256:${digest(readFileSync(file))}`) throw new Error(`Release asset already exists with different content: ${name}`)
  }
  // Check every existing file before uploading; never replace an existing asset.
  if (pending.length) runFn('gh', ['release', 'upload', tag, ...pending, '--repo', repository])
  console.log(`Desktop artifacts available on ${tag}`)
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { tag: { type: 'string' }, directory: { type: 'string' } } })
  const version = releaseVersion(values.tag)
  if (!values.directory || positionals.length !== 1) throw new Error('Usage: publish.mjs npm|cargo|assets --tag v1.2.3 --directory PATH')
  const directory = resolve(values.directory)
  if (positionals[0] === 'npm') await publishNpm(directory, version)
  else if (positionals[0] === 'cargo') await publishCargo(directory, version)
  else if (positionals[0] === 'assets') await publishAssets(directory, values.tag)
  else throw new Error(`Unknown publish target: ${positionals[0]}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
