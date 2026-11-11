import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { checkStorageQuota, createStorageEntry, decodeStorageEntry, STORAGE_LIMIT, storageSpaceSize } from '../packages/common/src/core/storage.js'

const appPath = process.argv[2]
assert(appPath, 'Usage: node scripts/check-wechat-storage-reference.mjs <wechatwebdevtools.app>')
const archive = await readFile(resolve(appPath, 'Contents/Resources/app.asar'))
const header = JSON.parse(archive.subarray(16, 16 + archive.readUInt32LE(12)).toString())
function file(path) {
	let entry = header
	for (const part of path.split('/')) entry = entry.files[part]
	assert(entry && !entry.unpacked, `Missing packed reference: ${path}`)
	const offset = 8 + archive.readUInt32LE(4) + Number(entry.offset)
	return archive.subarray(offset, offset + entry.size)
}
const vendor = file('js/vendor/2.25.3.wxvpkg')
const files = new Map()
let cursor = 18
for (let index = 0; index < vendor.readUInt32BE(14); index++) {
	const length = vendor.readUInt32BE(cursor); cursor += 4
	const name = vendor.toString('utf8', cursor, cursor + length); cursor += length
	const offset = vendor.readUInt32BE(cursor), size = vendor.readUInt32BE(cursor + 4); cursor += 8
	files.set(name, vendor.subarray(offset, offset + size))
}
const source = files.get('/WAService.js').toString()
const begin = source.indexOf('5256:') + 5
const end = source.indexOf('},727:', begin) + 1
assert(begin > 4 && end > begin, 'Storage utility module changed; review reference extraction')
const reference = {}
const require = id => { assert.equal(id, 6); return { Em: value => Object.prototype.toString.call(value).slice(8, -1) } }
require.d = (target, getters) => Object.defineProperties(target, Object.fromEntries(Object.entries(getters).map(([key, get]) => [key, { get }])))
runInNewContext(`(${source.slice(begin, end)})`)({}, reference, require)
const values = ['', '你😀"\\\n\u0000', 0, -0, Number.NaN, Infinity, -Infinity, false, true, null, undefined,
	new Date(1700000000000), new Date(Number.NaN), [1, undefined, null], { a: '你😀', missing: undefined }, /abc/, () => {}, Symbol('s')]
for (const value of values) {
	const expected = reference.op(value)
	const { data, dataType } = createStorageEntry('键😀', value)
	assert.deepEqual({ data, dataType }, { ...expected })
	const actual = decodeStorageEntry({ data, dataType })
	const decoded = reference.Yt(expected.data, expected.dataType)
	if (dataType === 'Date') assert(Object.is(actual.getTime(), decoded.getTime()))
	else if (typeof actual === 'object' && actual !== null) assert.equal(JSON.stringify(actual), JSON.stringify(decoded))
	else assert(Object.is(actual, decoded))
}

// Execute the actual developer-tool host handlers with an isolated namespace.
// Deliberately inspect the pre-write quota only: a rejected reference write mutates
// its in-memory cache, whereas Dimina keeps the last persisted value atomically.
const host = file('js/extensions/appservice/index.js').toString()
function functionSource(name, next) {
	const start = host.indexOf(`function ${name}(e,t,n`)
	const stop = host.indexOf(`function ${next}(`, start)
	assert(start >= 0 && stop > start, `Host storage ${name} layout changed`)
	return host.slice(start, stop)
}
const space = {}
const handlers = runInNewContext(`${functionSource('g', 'f')};${functionSource('T', 'C')};({set:g,info:T})`, {
	l: () => ({ 0: space }), _: { userMaxSize: 10 }, C: id => id === 0, d() {},
})
let quotaCases = 0
for (const delta of [-1, 0, 1]) {
	for (const key of Object.keys(space)) delete space[key]
	const overhead = storageSpaceSize([createStorageEntry('k', '').entrySize]) + 6
	const value = 'x'.repeat(STORAGE_LIMIT - overhead + delta)
	const entry = createStorageEntry('k', value)
	let expected
	handlers.set('setStorage', { key: 'k', data: entry.data, dataType: entry.dataType }, result => { expected = result })
	let actual = 'setStorage:ok'
	try { checkStorageQuota([entry.entrySize]) } catch (error) { actual = `setStorage:fail ${error.message}` }
	assert.equal(actual, expected.errMsg)
	if (delta <= 0) {
		let info
		handlers.info('getStorageInfo', {}, result => { info = result })
		assert.equal(Math.ceil(storageSpaceSize([entry.entrySize]) / 1024), info.currentSize)
		assert.equal(info.limitSize, 10240)
	}
	quotaCases++
}
console.log(JSON.stringify({ appVersion: JSON.parse(file('package.json')).version, baseVersion: JSON.parse(files.get('/WAVersion.json')).version,
	vendorSha256: createHash('sha256').update(vendor).digest('hex'), typedCases: values.length, quotaCases, result: 'matched' }, null, 2))
