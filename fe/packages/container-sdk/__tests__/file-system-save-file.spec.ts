import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Blob } from 'node:buffer'
import { MiniApp } from '../src/pages/miniApp/miniApp.js'

class FakeWritable {
	writes: Blob[] = []
	closed = false
	aborted = false

	async write(data: FileSystemWriteChunkType): Promise<void> {
		this.writes.push(data as Blob)
	}

	async close(): Promise<void> {
		this.closed = true
	}

	async abort(): Promise<void> {
		this.aborted = true
	}
}

class FakeFileHandle {
	writable = new FakeWritable()

	async createWritable(): Promise<FakeWritable> {
		return this.writable
	}
}

class FakeDirectoryHandle {
	directories = new Map<string, FakeDirectoryHandle>()
	files = new Map<string, FakeFileHandle>()

	async getDirectoryHandle(name: string): Promise<FakeDirectoryHandle> {
		let directory = this.directories.get(name)
		if (!directory) {
			directory = new FakeDirectoryHandle()
			this.directories.set(name, directory)
		}
		return directory
	}

	async getFileHandle(name: string): Promise<FakeFileHandle> {
		let file = this.files.get(name)
		if (!file) {
			file = new FakeFileHandle()
			this.files.set(name, file)
		}
		return file
	}
}

function callbackMessage(app: MiniApp, id: string) {
	return vi.mocked(app.jscore.postMessage).mock.calls.find(
		([message]) => message.type === 'triggerCallback' && message.body.id === id,
	)?.[0]
}

describe('Web FileSystemManager.saveFile', () => {
	let root: FakeDirectoryHandle
	let storageDescriptor: PropertyDescriptor | undefined

	beforeEach(() => {
		root = new FakeDirectoryHandle()
		storageDescriptor = Object.getOwnPropertyDescriptor(navigator, 'storage')
		Object.defineProperty(navigator, 'storage', {
			configurable: true,
			value: { getDirectory: vi.fn().mockResolvedValue(root) },
		})
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			blob: async () => new Blob(['report-content'], { type: 'text/plain' }),
		}) as unknown as typeof fetch
	})

	afterEach(() => {
		if (storageDescriptor) {
			Object.defineProperty(navigator, 'storage', storageDescriptor)
		}
		else {
			Reflect.deleteProperty(navigator, 'storage')
		}
	})

	it('persists the resource per app and returns the requested user path', async () => {
		const app = new MiniApp({ appId: 'wx-save-file', pagePath: 'pages/index/index' })
		vi.spyOn(app.jscore, 'postMessage')

		app.invokeApi('FileSystemManager.saveFile', {
			tempFilePath: 'data:text/plain,report-content',
			filePath: 'difile://usr/reports/report.txt',
			success: 'save-success',
			fail: 'save-fail',
			complete: 'save-complete',
		})

		await vi.waitFor(() => expect(callbackMessage(app, 'save-success')).toBeDefined())

		const result = callbackMessage(app, 'save-success')?.body.args as Record<string, unknown>
		expect(result).toEqual({
			savedFilePath: 'difile://usr/reports/report.txt',
			errMsg: 'FileSystemManager.saveFile:ok',
		})
		expect(callbackMessage(app, 'save-complete')?.body.args).toEqual(result)
		expect(callbackMessage(app, 'save-fail')).toBeUndefined()

		const appDirectory = root.directories.get('dimina-file-system')
			?.directories.get('wx-save-file')
			?.directories.get('usr')
			?.directories.get('reports')
		const writable = appDirectory?.files.get('report.txt')?.writable
		expect(writable?.closed).toBe(true)
		expect(await writable?.writes[0].text()).toBe('report-content')
	})

	it('generates a saved path when filePath is omitted', async () => {
		const app = new MiniApp({ appId: 'wx-save-file', pagePath: 'pages/index/index' })
		vi.spyOn(app.jscore, 'postMessage')

		app.invokeApi('FileSystemManager.saveFile', {
			tempFilePath: 'https://example.com/files/report.pdf?download=1',
			success: 'save-success',
		})

		await vi.waitFor(() => expect(callbackMessage(app, 'save-success')).toBeDefined())
		const result = callbackMessage(app, 'save-success')?.body.args as { savedFilePath: string }
		expect(result.savedFilePath).toMatch(/^difile:\/\/usr\/saved\/.+_report\.pdf$/)

		const savedDirectory = root.directories.get('dimina-file-system')
			?.directories.get('wx-save-file')
			?.directories.get('usr')
			?.directories.get('saved')
		expect(savedDirectory?.files.has(result.savedFilePath.split('/').pop()!)).toBe(true)
	})

	it('uses the container-specific prefix for validation and generated paths', async () => {
		const app = new MiniApp({
			appId: 'wx-custom-save-file',
			pagePath: 'pages/index/index',
			virtualFilePrefix: 'host-file://',
		})
		vi.spyOn(app.jscore, 'postMessage')

		app.invokeApi('FileSystemManager.saveFile', {
			tempFilePath: 'data:text/plain,report-content',
			filePath: 'host-file://usr/reports/report.txt',
			success: 'save-success',
		})

		await vi.waitFor(() => expect(callbackMessage(app, 'save-success')).toBeDefined())
		expect(callbackMessage(app, 'save-success')?.body.args).toEqual({
			savedFilePath: 'host-file://usr/reports/report.txt',
			errMsg: 'FileSystemManager.saveFile:ok',
		})
	})

	it('fails without creating a file when tempFilePath is missing', async () => {
		const app = new MiniApp({ appId: 'wx-save-file', pagePath: 'pages/index/index' })
		vi.spyOn(app.jscore, 'postMessage')

		app.invokeApi('FileSystemManager.saveFile', {
			fail: 'save-fail',
			complete: 'save-complete',
		})

		await vi.waitFor(() => expect(callbackMessage(app, 'save-fail')).toBeDefined())
		expect(callbackMessage(app, 'save-fail')?.body.args).toEqual({
			errMsg: 'FileSystemManager.saveFile:fail tempFilePath is required',
		})
		expect(callbackMessage(app, 'save-complete')?.body.args).toEqual(
			callbackMessage(app, 'save-fail')?.body.args,
		)
		expect(globalThis.fetch).not.toHaveBeenCalled()
	})

	it('rejects destinations outside the app user directory', async () => {
		const app = new MiniApp({ appId: 'wx-save-file', pagePath: 'pages/index/index' })
		vi.spyOn(app.jscore, 'postMessage')

		app.invokeApi('FileSystemManager.saveFile', {
			tempFilePath: 'data:text/plain,report-content',
			filePath: 'difile://tmp/report.txt',
			fail: 'save-fail',
		})

		await vi.waitFor(() => expect(callbackMessage(app, 'save-fail')).toBeDefined())
		expect(callbackMessage(app, 'save-fail')?.body.args).toEqual({
			errMsg: 'FileSystemManager.saveFile:fail filePath must be under wx.env.USER_DATA_PATH',
		})
		expect(globalThis.fetch).not.toHaveBeenCalled()
	})

	it('fails explicitly when the browser has no origin-private file system', async () => {
		Object.defineProperty(navigator, 'storage', {
			configurable: true,
			value: {},
		})
		const app = new MiniApp({ appId: 'wx-save-file', pagePath: 'pages/index/index' })
		vi.spyOn(app.jscore, 'postMessage')

		app.invokeApi('FileSystemManager.saveFile', {
			tempFilePath: 'data:text/plain,report-content',
			fail: 'save-fail',
		})

		await vi.waitFor(() => expect(callbackMessage(app, 'save-fail')).toBeDefined())
		expect(callbackMessage(app, 'save-fail')?.body.args).toEqual({
			errMsg: 'FileSystemManager.saveFile:fail origin private file system is not supported',
		})
		expect(globalThis.fetch).not.toHaveBeenCalled()
	})
})
