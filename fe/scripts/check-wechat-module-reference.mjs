import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

const appPath = process.argv[2]
if (!appPath) {
	console.error('Usage: node scripts/check-wechat-module-reference.mjs <wechatwebdevtools.app>')
	process.exit(1)
}

const archive = await readFile(resolve(appPath, 'Contents/Resources/app.asar'))
const header = JSON.parse(archive.subarray(16, 16 + archive.readUInt32LE(12)).toString())
function archiveFile(path) {
	let entry = header
	for (const segment of path.split('/')) entry = entry.files[segment]
	assert(entry && !entry.unpacked, 'Expected a packed reference file: ' + path)
	const offset = 8 + archive.readUInt32LE(4) + Number(entry.offset)
	return archive.subarray(offset, offset + entry.size)
}
const appVersion = JSON.parse(archiveFile('package.json')).version
const vendor = archiveFile('js/vendor/2.25.3.wxvpkg')
const entries = new Map()
let cursor = 18
for (let i = 0; i < vendor.readUInt32BE(14); i++) {
	const length = vendor.readUInt32BE(cursor)
	cursor += 4
	const name = vendor.toString('utf8', cursor, cursor + length)
	cursor += length
	const offset = vendor.readUInt32BE(cursor)
	const size = vendor.readUInt32BE(cursor + 4)
	cursor += 8
	entries.set(name, vendor.subarray(offset, offset + size))
}
const version = JSON.parse(entries.get('/WAVersion.json'))
const source = entries.get('/WAService.js').toString()
const start = source.indexOf('var O;T.definePlugin,T.requirePlugin;')
const end = source.indexOf('globalThis.define=O.define;', start)
assert(start >= 0 && end > start, 'Bundled WebNode layout changed; review the reference extraction')
const reference = runInNewContext(
	source.slice(start, end).replace('var O;T.definePlugin,T.requirePlugin;', 'var O;') + ';O',
	{
		s: { platform: 'devtools', subPackages: [] },
		v: { thirdErrorReport() {} },
		w: { info() {}, error() {} },
		c: { invoke(name, params, done) { done({ loaded: false }) } },
		console,
		setTimeout,
	},
)
const amdPath = fileURLToPath(new URL('../packages/common/src/core/amd.js', import.meta.url))
const diminaSource = (await readFile(amdPath, 'utf8'))
	.replace(/^import .*$/m, '')
	.replace(/^export .*$/m, '')
const dimina = runInNewContext(
	diminaSource + ';({ define: modDefine, require: modRequire })',
	{ isFunction: value => typeof value === 'function', console: { error() {} }, setTimeout },
)
const wx = {
	define: reference.define,
	require: (id, success, fail) => reference.require(id, undefined, success, '', undefined, fail),
}

async function probe(loader) {
	const results = {}
	loader.define('strict.js', function (require, module) {
		'use strict'
		module.exports = this
	})
	results.strictFactoryThis = typeof loader.require('strict.js')
	loader.define('cycle-a.js', (require, module, exports) => {
		exports.stage = 'initializing'
		exports.b = require('cycle-b.js')
		exports.stage = 'ready'
	})
	loader.define('cycle-b.js', (require, module, exports) => {
		exports.a = require('cycle-a.js')
		exports.stage = exports.a.stage
	})
	const a = loader.require('cycle-a.js')
	results.cycle = { observed: a.b.stage, sameObject: a.b.a === a }

	const first = (require, module) => { module.exports = { version: 1 } }
	loader.define('version.js', first)
	const original = loader.require('version.js')
	loader.define('version.js', first)
	const sameObject = loader.require('version.js') === original
	loader.define('version.js', (require, module) => { module.exports = { version: 2 } })
	results.redefinition = { sameObject, version: loader.require('version.js').version }

	let attempts = 0
	const error = new Error('module evaluation failed')
	loader.define('retry.js', (require, module, exports) => {
		if (++attempts === 1) { exports.stale = true; throw error }
		exports.ready = true
	})
	let sameError = false
	try { loader.require('retry.js') } catch (caught) { sameError = caught === error }
	results.retry = { sameError, exports: loader.require('retry.js') }

	const events = []
	loader.define('callback.js', (require, module) => { module.exports = 42 })
	const returned = loader.require('callback.js', result => events.push(result))
	events.push('after')
	await new Promise(done => setTimeout(done, 0))
	results.callback = { returnType: typeof returned, events }

	loader.define('failure.js', () => { throw new Error('async evaluation failed') })
	results.asyncFailure = await new Promise((done) => {
		loader.require('failure.js', () => done('unexpected success'), done)
	})
	return JSON.parse(JSON.stringify(results))
}

const expected = await probe(wx)
const actual = await probe(dimina)
assert.deepEqual(actual, expected)
console.log(JSON.stringify({
	appVersion,
	baseVersion: version.version,
	vendorSha256: createHash('sha256').update(vendor).digest('hex'),
	contracts: actual,
}, null, 2))
