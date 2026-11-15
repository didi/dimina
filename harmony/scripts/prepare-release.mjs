import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

export function prepareRelease(root, tag) {
  const number = '(?:0|[1-9][0-9]*)'
  const identifier = `(?:${number}|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)`
  const match = new RegExp(`^v(${number}\\.${number}\\.${number})(?:-(${identifier}(?:\\.${identifier})*))?$`).exec(tag || '')
  if (!match || match[0] !== tag) {
    throw new Error('Expected a SemVer release tag with v prefix and no build metadata')
  }
  const version = tag.slice(1)
  const corePath = resolve(root, 'harmony/dimina/oh-package.json5')
  const adapterPath = resolve(root, 'harmony/map_amap/oh-package.json5')
  const core = JSON.parse(readFileSync(corePath, 'utf8'))
  const adapter = JSON.parse(readFileSync(adapterPath, 'utf8'))
  if (adapter.version !== core.version || adapter.dependencies?.[core.name] !== core.version) {
    throw new Error('Core, AMap adapter and its core dependency must have matching versions')
  }
  if (core.version !== version && !(match[2] && core.version === match[1])) {
    throw new Error('Release tag must match the source version or its prerelease base')
  }
  if (core.version !== version) {
    core.version = version
    adapter.version = version
    adapter.dependencies[core.name] = version
    writeFileSync(corePath, `${JSON.stringify(core, null, 2)}\n`)
    writeFileSync(adapterPath, `${JSON.stringify(adapter, null, 2)}\n`)
  }
  return version
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: { tag: { type: 'string' }, root: { type: 'string', default: process.cwd() } } })
    console.log(`Prepared Harmony release ${prepareRelease(values.root, values.tag)}`)
  }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
