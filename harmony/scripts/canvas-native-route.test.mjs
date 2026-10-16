// Execute the production N-API router against Node's real environments/TSFN.
// Only ArkWeb is adapted: portable CI has no device WebView or GPU.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const output = mkdtempSync(join(tmpdir(), 'dimina-canvas-napi-'))
const root = fileURLToPath(new URL('../../', import.meta.url))
const fixture = fileURLToPath(new URL('./fixtures/', import.meta.url))
const headers = [resolve(dirname(process.execPath), '../include/node'), '/usr/include/node', '/usr/local/include/node']
	.find(path => existsSync(join(path, 'node_api.h')))
assert.ok(headers, 'Node distribution must include its N-API headers')
const binary = join(output, 'route.node')
try {
	const compile = spawnSync(process.env.CXX ?? 'c++', ['-std=c++17', '-O2', '-UNDEBUG', '-pthread',
		...(process.platform === 'darwin' ? ['-bundle', '-undefined', 'dynamic_lookup'] : ['-shared', '-fPIC']),
		'-I', join(fixture, 'include'), '-I', headers, '-I', join(root, 'harmony/dimina/src/main/cpp'),
		join(fixture, 'canvas-native-route.cpp'), join(root, 'harmony/dimina/src/main/cpp/canvas_ui_route.cpp'), '-o', binary], { encoding: 'utf8' })
	assert.equal(compile.status, 0, compile.stderr || compile.error?.message)
	process.env.DIMINA_CANVAS_ADDON = binary
	await import('./fixtures/canvas-native-route-cases.mjs')
}
catch (error) { rmSync(output, { recursive: true, force: true }); throw error }
process.on('exit', () => rmSync(output, { recursive: true, force: true }))
