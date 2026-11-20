import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import vm from 'node:vm'

const require = createRequire(new URL('../../fe/packages/compiler/package.json', import.meta.url))
const { transformSync } = require('esbuild')
const source = new URL('../dimina/src/main/ets/EventTrack/DMPRuntimeDiagnostics.ets', import.meta.url)

test('native startup and Worker Bridge callbacks share a bounded diagnostics export', () => {
	const { code } = transformSync(readFileSync(source, 'utf8'), { loader: 'ts', format: 'cjs' })
	const module = { exports: {} }
	let now = 100
	vm.runInNewContext(code, {
		module,
		exports: module.exports,
		require(name) {
			assert.equal(name, '@kit.BasicServicesKit')
			return { systemDateTime: { getUptime: () => now, TimeType: { STARTUP: 0 } } }
		},
	})
	const diagnostics = module.exports.DMPRuntimeDiagnostics
	assert.equal(diagnostics.json(), undefined)
	diagnostics.configure(true, 'fixture-version')
	const stale = diagnostics.beginCall('stale', 'demo')
	diagnostics.configure(true, 'fixture-version')
	diagnostics.recordCall(stale, 'api-callback', 'fail')
	diagnostics.launch('launch-start', 'demo', 'pages/index?token=private')
	for (let i = 0; i < 201; i++) diagnostics.beginCall('setStorage', 'demo')
	now = 118
	const event = {
		generation: diagnostics.captureGeneration, id: 'worker-1-1', api: 'getStorage',
		bridgeId: '3', phase: 'api-received', timestamp: 110,
	}
	diagnostics.recordWorkerEvent(event, 'demo', 'pages/index')
	diagnostics.recordWorkerEvent({ ...event, phase: 'api-callback', outcome: 'success', timestamp: 115 }, 'demo')
	const json = diagnostics.json()
	assert.doesNotMatch(json, /private|stale/)
	const report = JSON.parse(json)
	assert.equal(report.events.length, 201)
	assert.equal(report.events[0].pagePath, 'pages/index')
	assert.deepEqual(report.events.slice(-2).map(({ callId, phase, elapsedMs }) => [callId, phase, elapsedMs]), [
		['worker-1-1', 'api-received', 10],
		['worker-1-1', 'api-callback', 15],
	])
	diagnostics.configure(false)
	assert.equal(diagnostics.json(), undefined)
})
