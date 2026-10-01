import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { installWXWebAssembly } from '../src/core/webassembly.js'
import { canIUse } from '../src/api/core/base/index.js'

const binary = new Uint8Array(readFileSync(new URL('../../../../native/wasm/tests/fixtures/memory.wasm', import.meta.url))).buffer
function scope(fs = {}) {
	return { WebAssembly, __VIRTUAL_FILE_PREFIX__: 'difile://', wx: { getFileSystemManager: () => fs } }
}

describe('WXWebAssembly', () => {
	it('installs before library imports and reflects real runtime capability', () => {
		const env = scope()
		const wasm = installWXWebAssembly(env)
		expect(env.WXWebAssembly).toBe(wasm)
		vi.stubGlobal('WXWebAssembly', wasm)
		try {
			expect(canIUse('WXWebAssembly')).toBe(true)
			expect(canIUse('WXWebAssembly.instantiate')).toBe(true)
			expect(canIUse('WXWebAssembly.missing')).toBe(false)
		} finally { vi.unstubAllGlobals() }
		const absent = {}
		expect(installWXWebAssembly(absent)).toBeUndefined()
		expect(absent).not.toHaveProperty('WXWebAssembly')
	})

	it('accepts byte views with offsets and returns the correct instantiate overload', async () => {
		const wasm = installWXWebAssembly(scope())
		const padded = new Uint8Array(binary.byteLength + 9)
		padded.set(new Uint8Array(binary), 5)
		const view = padded.subarray(5, 5 + binary.byteLength)
		expect(wasm.validate(view)).toBe(true)
		const { module, instance } = await wasm.instantiate(view, { host: { callback: n => n + 3 } })
		expect(instance.exports.host(7)).toBe(10)
		expect(module).toBeInstanceOf(wasm.Module)
		const second = await wasm.instantiate(module, { host: { callback: n => n + 9 } })
		expect(second).toBeInstanceOf(wasm.Instance)
		expect(second.exports.host(7)).toBe(16)
		expect(instance.exports.host(7)).toBe(10)
		expect(second.exports.memory.buffer).not.toBe(instance.exports.memory.buffer)
	})

	it('reads .wasm.br through Brotli file API and shares concurrent compilation with separate instances', async () => {
		let finish
		const fs = { readCompressedFile: vi.fn(opts => { finish = opts.success }) }
		const wasm = installWXWebAssembly(scope(fs))
		const first = wasm.instantiate('/utils/libpag.wasm.br', { host: { callback: n => n + 1 } })
		const second = wasm.instantiate('/utils/libpag.wasm.br', { host: { callback: n => n + 2 } })
		expect(fs.readCompressedFile).toHaveBeenCalledTimes(1)
		expect(fs.readCompressedFile).toHaveBeenCalledWith(expect.objectContaining({ filePath: '/utils/libpag.wasm.br', compressionAlgorithm: 'br' }))
		finish({ data: binary })
		const [a, b] = await Promise.all([first, second])
		expect(a.module).toBe(b.module)
		expect(a.instance.exports.host(10)).toBe(11)
		expect(b.instance.exports.host(10)).toBe(12)
	})

	it('reads uncompressed and sandbox files and observes subsequent changes', async () => {
		const fs = { readFile: vi.fn(opts => opts.success({ data: binary })) }
		const wasm = installWXWebAssembly(scope(fs))
		await wasm.compile('utils/libpag.wasm')
		await wasm.compile('difile://usr/custom.wasm')
		await wasm.compile('difile://usr/custom.wasm')
		expect(fs.readFile).toHaveBeenCalledTimes(3)
		await expect(wasm.compile('https://example.com/custom.wasm')).rejects.toThrow('local package')
	})

	it('rejects invalid modules and link failures, and permits retry after a failed file read', async () => {
		const fs = { readCompressedFile: vi.fn()
			.mockImplementationOnce(opts => opts.fail({ errMsg: 'missing package' }))
			.mockImplementationOnce(opts => opts.success({ data: binary })) }
		const wasm = installWXWebAssembly(scope(fs))
		await expect(wasm.compile('missing.wasm.br')).rejects.toThrow('missing package')
		expect(await wasm.compile('missing.wasm.br')).toBeInstanceOf(wasm.Module)
		expect(wasm.validate(new Uint8Array([1, 2, 3]))).toBe(false)
		await expect(wasm.compile(new Uint8Array([1, 2, 3]))).rejects.toBeInstanceOf(wasm.CompileError)
		await expect(wasm.instantiate(binary, { host: {} })).rejects.toBeInstanceOf(wasm.LinkError)
	})
})
