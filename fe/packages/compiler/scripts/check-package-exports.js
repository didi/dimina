import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import packageJson from '../package.json' with { type: 'json' }

const publicEntries = [
	'@dimina/compiler',
	'@dimina/compiler/view-compiler',
	'@dimina/compiler/logic-compiler',
	'@dimina/compiler/style-compiler',
]

for (const entry of publicEntries) {
	await import(entry)
}

const cliResult = spawnSync(process.execPath, ['dist/bin/index.js', '--version'], {
	cwd: new URL('..', import.meta.url),
	encoding: 'utf8',
})

assert.equal(cliResult.status, 0, cliResult.stderr)
assert.equal(cliResult.stdout.trim(), packageJson.version)

console.log(`Validated ${publicEntries.length} ESM exports and the dmcc CLI.`)
