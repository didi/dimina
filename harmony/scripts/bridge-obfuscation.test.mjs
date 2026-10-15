import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const sdk = fileURLToPath(new URL('../dimina/', import.meta.url))
const rules = readFileSync(join(sdk, 'consumer-rules.txt'), 'utf8')
function section(option) {
	const lines = rules.split('\n'), start = lines.indexOf(option)
	assert.ok(start >= 0, `missing ${option}`)
	const names = new Set()
	for (const line of lines.slice(start + 1)) {
		const value = line.trim()
		if (value.startsWith('-')) break
		if (value && !value.startsWith('#')) names.add(value)
	}
	return names
}
const properties = section('-keep-property-name')
function sources(directory) {
	return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
		? sources(join(directory, entry.name)) : /\.(ets|ts)$/.test(entry.name) ? [join(directory, entry.name)] : [])
}
test('consumer obfuscation preserves every literal bridge dispatch method', () => {
	let count = 0
	for (const path of sources(join(sdk, 'src/main/ets/Bridges'))) {
		const text = readFileSync(path, 'utf8')
		for (const method of text.matchAll(/getExportMethods\(\)\s*:\s*(?:string\[\]|Array<string>)\s*\{\s*return\s*\[([\s\S]*?)\]/g)) {
			for (const name of method[1].matchAll(/['"]([A-Za-z_$][\w$]*)['"]/g)) {
				count++
				assert.ok(properties.has(name[1]), `${path}: ${name[1]} would be renamed before string dispatch`)
			}
		}
	}
	assert.ok(count > 150, 'bridge registry scan must include the real exported API lists')
})
test('Worker RPC and WebView proxy names remain callable across language boundaries', () => {
	for (const name of ['toContainer', 'toRender', 'invoke', 'publish', 'requestKeyboard']) assert.ok(properties.has(name), name)
})
test('cross-thread DTO and plain JS message fields keep the same wire names', () => {
	const messages = readFileSync(join(sdk, 'src/main/ets/Service/DMPSendableObjects.ets'), 'utf8')
	for (const field of messages.matchAll(/^\s+(\w+)\??\s*:\s*[^\n]+/gm)) assert.ok(properties.has(field[1]), field[1])
	for (const field of ['type', 'body', 'target']) assert.ok(properties.has(field), field)
	for (const field of ['bridgeId', 'pagePath']) assert.ok(properties.has(field), `resourceLoaded.${field}`)
})
test('native Node-API exports and returned frame fields keep their declared names', () => {
	const native = readFileSync(join(sdk, 'src/main/cpp/types/libdimina/Index.d.ts'), 'utf8')
	const globals = section('-keep-global-name')
	for (const name of native.matchAll(/export const\s+(\w+)/g)) {
		assert.ok(properties.has(name[1]), name[1])
		assert.ok(globals.has(name[1]), name[1])
	}
	for (const field of native.matchAll(/^\s+(\w+)\??:/gm)) assert.ok(properties.has(field[1]), field[1])
})
