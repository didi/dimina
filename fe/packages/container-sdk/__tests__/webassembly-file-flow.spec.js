import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installWXWebAssembly } from '../../service/src/core/webassembly.js'
import { MiniApp } from '../src/pages/miniApp/miniApp.js'

const assetRoot = resolve(import.meta.dirname, '../../../../examples/miniprogram/base/pages/wasm/assets')

afterEach(() => vi.unstubAllGlobals())

describe('Web package files to WXWebAssembly', () => {
	it.each(['wasm', 'wasm.br'])('instantiates the actual demo.%s through the container file bridge', async (format) => {
		const app = new MiniApp({ appId: 'wx-wasm-flow', pagePath: 'pages/wasm/index', resourceBaseUrl: '/resources/' })
		const callbacks = new Map()
		vi.spyOn(app.jscore, 'postMessage').mockImplementation((message) => {
			if (message.type === 'triggerCallback') callbacks.get(message.body.id)?.(structuredClone(message.body.args))
		})
		let nextCallback = 0
		const bridgeRead = name => (options) => {
			const success = `success-${nextCallback}`
			const fail = `fail-${nextCallback++}`
			const finish = callback => (result) => {
				callbacks.delete(success)
				callbacks.delete(fail)
				callback(result)
			}
			callbacks.set(success, finish(options.success))
			callbacks.set(fail, finish(options.fail))
			app.invokeApi(name, { ...options, success, fail })
		}
		const file = readFileSync(resolve(assetRoot, `demo.${format}`))
		const fileBytes = new Uint8Array(file).buffer
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => fileBytes }))
		const wasm = installWXWebAssembly({
			WebAssembly,
			wx: { getFileSystemManager: () => ({
				readFile: bridgeRead('FileSystemManager.readFile'),
				readCompressedFile: bridgeRead('FileSystemManager.readCompressedFile'),
			}) },
		})
		const { instance } = await wasm.instantiate(`/pages/wasm/assets/demo.${format}`, { env: { double: value => value * 2 } })
		const exports = instance.exports
		expect(exports.add(21, 21)).toBe(42)
		expect(exports.callHost(21)).toBe(42)
		exports.write(0, 100)
		const before = exports.memory.buffer
		expect(new DataView(before).getInt32(0, true)).toBe(100)
		expect(exports.memory.grow(1)).toBe(1)
		expect(before.byteLength).toBe(0)
		new DataView(exports.memory.buffer).setInt32(65536, 101, true)
		expect(exports.read(65536)).toBe(101)
		expect(fetch).toHaveBeenCalledWith(`${window.location.origin}/resources/wx-wasm-flow/main/pages/wasm/assets/demo.${format}`, expect.anything())
		expect(callbacks.size).toBe(0)
	})
})
