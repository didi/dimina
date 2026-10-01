import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Blob } from 'node:buffer'
import { MiniApp } from '../src/pages/miniApp/miniApp.js'
import { brotliCompressSync } from 'node:zlib'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

interface FileResult { data?: ArrayBuffer | string, errMsg: string }

let callbackId = 0

function createApp(appId = 'wx-read', virtualFilePrefix = 'difile://') {
	const app = new MiniApp({ appId, pagePath: 'pages/index/index', resourceBaseUrl: '/resources/', virtualFilePrefix })
	vi.spyOn(app.jscore, 'postMessage').mockImplementation(() => {})
	return app
}

async function call(app: MiniApp, options: Record<string, unknown>, method = 'readFile'): Promise<FileResult> {
	const id = `file-${++callbackId}`
	app.invokeApi(`FileSystemManager.${method}`, { ...options, success: `${id}-success`, fail: `${id}-fail`, complete: `${id}-complete` })
	const messages = vi.mocked(app.jscore.postMessage).mock.calls
	await vi.waitFor(() => expect(messages.filter(([message]) => message.type === 'triggerCallback' && String(message.body.id).startsWith(id))).toHaveLength(2))
	const callbacks = messages.filter(([message]) => message.type === 'triggerCallback' && String(message.body.id).startsWith(id)).map(([message]) => message)
	expect(callbacks[1].body.id).toBe(`${id}-complete`)
	expect(callbacks[1].body.args).toBe(callbacks[0].body.args)
	return callbacks[0].body.args as FileResult
}

function serve(bytes: Uint8Array) {
	vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => Uint8Array.from(bytes).buffer }))
}

class MemoryDirectory {
	directories = new Map<string, MemoryDirectory>()
	files = new Map<string, Blob>()
	async getDirectoryHandle(name: string, options: { create?: boolean } = {}): Promise<MemoryDirectory> {
		if (!this.directories.has(name)) {
			if (!options.create) throw new Error('file not found')
			this.directories.set(name, new MemoryDirectory())
		}
		return this.directories.get(name)!
	}
	async getFileHandle(name: string, options: { create?: boolean } = {}) {
		if (!this.files.has(name) && !options.create) throw new Error('file not found')
		return {
			getFile: async () => this.files.get(name),
			createWritable: async () => ({
				write: async (data: Blob) => { this.files.set(name, data) },
				close: async () => {}, abort: async () => {},
			}),
		}
	}
}

let storageDescriptor: PropertyDescriptor | undefined
beforeEach(() => { storageDescriptor = Object.getOwnPropertyDescriptor(navigator, 'storage') })
afterEach(() => {
	vi.unstubAllGlobals()
	if (storageDescriptor) Object.defineProperty(navigator, 'storage', storageDescriptor)
	else Reflect.deleteProperty(navigator, 'storage')
})

describe('Web FileSystemManager file reads', () => {
	it('decompresses package Brotli bytes through the filesystem bridge', async () => {
		const app = new MiniApp({ appId: 'wx-read', pagePath: 'pages/index/index' })
		const messages = vi.spyOn(app.jscore, 'postMessage')
		const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])
		const compressed = Uint8Array.from(brotliCompressSync(bytes))
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => compressed.buffer }))
		app.invokeApi('FileSystemManager.readCompressedFile', {
			filePath: '/runtime/test.wasm.br', compressionAlgorithm: 'br', success: 'read-success', fail: 'read-fail',
		})
		await vi.waitFor(() => expect(messages).toHaveBeenCalled())
		const result = messages.mock.calls.find(([message]) => message.type === 'triggerCallback')?.[0]
		expect(result?.body.args).toEqual({ data: bytes.buffer, errMsg: 'FileSystemManager.readCompressedFile:ok' })
	})
	it('reads package bytes through invokeApi instead of reporting an unsupported API', async () => {
		const app = new MiniApp({ appId: 'wx-read', pagePath: 'pages/index/index', resourceBaseUrl: '/resources/' })
		const messages = vi.spyOn(app.jscore, 'postMessage')
		const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => bytes.buffer }))
		app.invokeApi('FileSystemManager.readFile', {
			filePath: '/runtime/test.wasm', success: 'read-success', fail: 'read-fail', complete: 'read-complete',
		})
		await vi.waitFor(() => expect(messages).toHaveBeenCalled())
		const result = messages.mock.calls.find(([message]) => message.type === 'triggerCallback')?.[0]
		expect(result?.body.args).toEqual({ data: bytes.buffer, errMsg: 'FileSystemManager.readFile:ok' })
		expect(result?.body.id).toBe('read-success')
		expect(fetch).toHaveBeenCalledWith(`${window.location.origin}/resources/wx-read/main/runtime/test.wasm`, expect.anything())
	})

	it('uses declared nested subpackage roots and leaves similarly named main paths in main', async () => {
		serve(new Uint8Array([1, 2, 3]))
		const app = createApp()
		app.appConfig = { app: { entryPagePath: 'pages/index/index', pages: [], subPackages: [{ root: 'packages/a/' }] }, modules: {} }
		await call(app, { filePath: '/packages/a/assets/module.wasm' })
		expect(fetch).toHaveBeenLastCalledWith(`${window.location.origin}/resources/wx-read/packages/a/assets/module.wasm`, expect.anything())
		await call(app, { filePath: './packages/another/module.wasm' })
		expect(fetch).toHaveBeenLastCalledWith(`${window.location.origin}/resources/wx-read/main/packages/another/module.wasm`, expect.anything())
	})

	it('uses the configured resource origin and URL-encodes file names', async () => {
		serve(new Uint8Array([1]))
		const app = createApp()
		app.appInfo.resourceBaseUrl = 'https://cdn.example.com/tenant/apps/'
		await call(app, { filePath: '/assets/a b#c?.wasm' })
		expect(fetch).toHaveBeenLastCalledWith('https://cdn.example.com/tenant/apps/wx-read/main/assets/a%20b%23c%3F.wasm', { credentials: 'same-origin', redirect: 'error' })
	})

	it('returns the exact byte range without decoding or aliasing the fetch buffer', async () => {
		const source = new Uint8Array([0, 128, 255, 1, 2, 3])
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => source.buffer }))
		const result = await call(createApp(), { filePath: '/bytes.bin', position: 1, length: 3 })
		expect(Array.from(new Uint8Array(result.data as ArrayBuffer))).toEqual([128, 255, 1])
		expect(result.data).not.toBe(source.buffer)
	})

	it.each(['ascii', 'base64', 'binary', 'hex', 'ucs2', 'ucs-2', 'utf16le', 'utf-16le', 'utf8', 'utf-8', 'latin1'])('decodes %s after applying the byte range', async (encoding) => {
		const source = Buffer.from([0, 0xEF, 0xBB, 0xBF, 0x41, 0, 0x80, 0xFF, 0x42, 0, 1])
		serve(source)
		const result = await call(createApp(), { filePath: '/text.bin', encoding, position: 1, length: 9 })
		expect(result.data).toBe(source.subarray(1, 10).toString(encoding as BufferEncoding))
	})

	it('reads saved custom-prefix files and keeps identical user paths isolated per app', async () => {
		const root = new MemoryDirectory()
		Object.defineProperty(navigator, 'storage', { configurable: true, value: { getDirectory: async () => root } })
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(['private data']) }))
		const owner = createApp('wx-owner', 'host-file://')
		const path = 'host-file://usr/private/file.txt'
		await call(owner, { tempFilePath: 'data:text/plain,private-data', filePath: path }, 'saveFile')
		expect((await call(owner, { filePath: path, encoding: 'utf8' })).data).toBe('private data')
		expect((await call(createApp('wx-other', 'host-file://'), { filePath: path })).errMsg).toMatch(/:fail file not found/)
		vi.mocked(fetch).mockClear()
		expect((await call(owner, { filePath: 'difile://usr/private/file.txt' })).errMsg).toMatch(/:fail/)
		expect(fetch).not.toHaveBeenCalled()
	})

	it('reads temporary OPFS files without creating missing directories', async () => {
		const root = new MemoryDirectory()
		Object.defineProperty(navigator, 'storage', { configurable: true, value: { getDirectory: async () => root } })
		let directory = await root.getDirectoryHandle('dimina-file-system', { create: true })
		directory = await directory.getDirectoryHandle('wx-read', { create: true })
		directory = await directory.getDirectoryHandle('tmp', { create: true })
		directory.files.set('capture.bin', new Blob([new Uint8Array([0, 255, 128])]))
		const app = createApp()
		expect(Array.from(new Uint8Array((await call(app, { filePath: 'difile://tmp/capture.bin' })).data as ArrayBuffer))).toEqual([0, 255, 128])
		expect((await call(app, { filePath: 'difile://tmp/missing/file.bin' })).errMsg).toMatch(/:fail/)
		expect(directory.directories.has('missing')).toBe(false)
	})

	it('reads only temporary blob URLs owned by this mini program', async () => {
		serve(new Uint8Array([1, 2]))
		const app = createApp()
		const url = `blob:${window.location.origin}/owned-file`
		app._tempObjectUrls.add(url)
		expect((await call(app, { filePath: url })).errMsg).toBe('FileSystemManager.readFile:ok')
		vi.mocked(fetch).mockClear()
		expect((await call(createApp('wx-other'), { filePath: url })).errMsg).toMatch(/does not belong/)
		expect(fetch).not.toHaveBeenCalled()
	})

	it.each(['../other/file.wasm', '/%2e%2e/other/file.wasm', '/a/%2fsecret.wasm', '/a/%5csecret.wasm', '/a/%00file.wasm', 'https://example.com/file.wasm', '//example.com/file.wasm', 'file:///secret', 'difile://cache/file.wasm'])('rejects paths outside the app sandbox: %s', async (filePath) => {
		serve(new Uint8Array([1]))
		expect((await call(createApp(), { filePath })).errMsg).toMatch(/^FileSystemManager.readFile:fail /)
		expect(fetch).not.toHaveBeenCalled()
	})

	it.each([{ position: -1 }, { position: 0.5 }, { position: 3 }, { length: 0 }, { length: 4 }, { length: 1.5 }, { encoding: 'unsupported' }])('rejects invalid read options %j', async (options) => {
		serve(new Uint8Array([1, 2, 3]))
		expect((await call(createApp(), { filePath: '/file.bin', ...options })).errMsg).toMatch(/:fail/)
	})

	it('reads an empty file when no range is specified', async () => {
		serve(new Uint8Array())
		expect((await call(createApp(), { filePath: '/empty.bin' })).data).toEqual(new ArrayBuffer(0))
	})

	it('reports fetch failure to fail and complete without calling success', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }))
		expect(await call(createApp(), { filePath: '/missing.wasm' })).toEqual({ errMsg: 'FileSystemManager.readFile:fail failed to read filePath: HTTP 404' })
	})

	it('rejects unsupported compression algorithms before reading', async () => {
		serve(new Uint8Array([1]))
		expect((await call(createApp(), { filePath: '/file.wasm.gz', compressionAlgorithm: 'gzip' }, 'readCompressedFile')).errMsg).toMatch(/:fail compressionAlgorithm must be br/)
		expect(fetch).not.toHaveBeenCalled()
	})

	it('reports corrupted Brotli bytes through fail and complete', async () => {
		serve(new Uint8Array([255, 255, 255]))
		expect((await call(createApp(), { filePath: '/broken.wasm.br', compressionAlgorithm: 'br' }, 'readCompressedFile')).errMsg).toMatch(/^FileSystemManager.readCompressedFile:fail /)
	})

	it('accepts a valid compressed empty file', async () => {
		serve(Uint8Array.from(brotliCompressSync(Buffer.alloc(0))))
		expect((await call(createApp(), { filePath: '/empty.br', compressionAlgorithm: 'br' }, 'readCompressedFile')).data).toEqual(new ArrayBuffer(0))
	})

	it.each(['br', ' Br ', 'gzip, br'])('does not decode Brotli twice after Fetch removes HTTP content encoding %s', async (encoding) => {
		const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
			ok: true,
			headers: new Headers({ 'Content-Encoding': encoding }),
			arrayBuffer: async () => bytes.buffer,
		}))
		expect((await call(createApp(), { filePath: '/demo.wasm.br', compressionAlgorithm: 'br' }, 'readCompressedFile')).data).toEqual(bytes.buffer)
	})

	it('does not treat an unknown HTTP coding chain containing br as already decoded', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
			ok: true,
			headers: new Headers({ 'Content-Encoding': 'custom, br' }),
			arrayBuffer: async () => new Uint8Array([255, 255, 255]).buffer,
		}))
		expect((await call(createApp(), { filePath: '/broken.br', compressionAlgorithm: 'br' }, 'readCompressedFile')).errMsg).toMatch(/:fail /)
	})

	it.each([new Uint8Array(), new Uint8Array([1]), new Uint8Array([17, 1])])('rejects truncated or reserved Brotli headers %j', async (bytes) => {
		serve(bytes)
		expect((await call(createApp(), { filePath: '/broken.br', compressionAlgorithm: 'br' }, 'readCompressedFile')).errMsg).toMatch(/:fail /)
	})

	it('rejects the real demo Brotli stream when its final byte is missing', async () => {
		const demo = readFileSync(resolve(import.meta.dirname, '../../../../examples/miniprogram/base/pages/wasm/assets/demo.wasm.br'))
		serve(demo.subarray(0, -1))
		expect((await call(createApp(), { filePath: '/runtime/demo.wasm.br', compressionAlgorithm: 'br' }, 'readCompressedFile')).errMsg).toMatch(/:fail /)
	})
})
