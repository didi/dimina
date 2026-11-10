import { sha256 } from '@noble/hashes/sha2.js'

export const isMainThread = true
export const parentPort = null
export const env = { TARGET_PATH: '/output', ASSETS_PATH_PREFIX: '1' }
export const tmpdir = () => '/tmp'
export const fileURLToPath = value => new URL(value).pathname
export const pathToFileURL = value => new URL(`file://${value}`)
// Browser builds execute one compilation per Worker and never share contexts.
export class AsyncLocalStorage {
	getStore() { return undefined }
	run(_context, callback) { return callback() }
}
export function createRequire() { return () => { throw new Error('Node modules are unavailable in the browser compiler') } }
export function createHash() {
	let input = ''
	return {
		update(value) { input += value; return this },
		digest() {
			const bytes = sha256(new TextEncoder().encode(input))
			return { readBigUInt64BE: offset => new DataView(bytes.buffer).getBigUint64(offset) }
		},
	}
}
export default { env, tmpdir, createHash }
