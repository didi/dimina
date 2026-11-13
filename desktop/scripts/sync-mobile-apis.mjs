import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { supportedWxApis } from '../../fe/packages/compiler/src/common/compatibility-reference.js'

const reference = readFileSync(new URL('../../docs/API-Reference.md', import.meta.url), 'utf8')
const section = reference.split(/^## API 列表\s*$/m)[1]?.split(/^## /m)[0]
if (!section) throw new Error('Mobile API reference section is missing')
const known = new Set(supportedWxApis)
const names = new Set()
for (const line of section.split('\n')) {
  if (!line.trim().startsWith('|')) continue
  const cells = line.trim().split('|').slice(1, -1).map(cell => cell.trim().replaceAll('`', ''))
  if (known.has(cells[1]) && cells.slice(2, 5).some(cell => cell.includes('✓'))) names.add(cells[1])
}
if (!names.has('getNetworkType') || !names.has('scanCode')) throw new Error('Mobile API reference table is invalid')
const output = JSON.stringify([...names].sort(), null, 2) + '\n'
const target = new URL('../mobile_api_names.json', import.meta.url)
if (process.argv.includes('--check')) {
  // Windows checkout may convert generated JSON to CRLF without changing APIs.
  if (readFileSync(target, 'utf8').replace(/\r\n/g, '\n') !== output) {
    throw new Error('Mobile API manifest is stale; run node desktop/scripts/sync-mobile-apis.mjs')
  }
} else writeFileSync(target, output)
console.log(`Mobile API manifest: ${fileURLToPath(target)}`)
