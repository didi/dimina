import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/api/common', () => ({
	invokeAPI: vi.fn(),
}))

import { invokeAPI } from '@/api/common'
import { canIUse, env } from '../src/api/core/base/index.js'
import { getFileSystemManager } from '../src/api/core/file/index.js'

function bytes(buffer) {
	return Array.from(new Uint8Array(buffer))
}

describe('file api service adapter', () => {
	beforeEach(() => {
		vi.mocked(invokeAPI).mockReset()
	})

	it('exposes wx.env.USER_DATA_PATH as the user file root', () => {
		expect(env.USER_DATA_PATH).toBe('difile://usr')
	})

	it('returns a singleton FileSystemManager', () => {
		expect(getFileSystemManager()).toBe(getFileSystemManager())
	})

	it('marks FileSystemManager schemas as available in canIUse', () => {
		expect(canIUse('getFileSystemManager')).toBe(true)
		expect(canIUse('FileSystemManager')).toBe(true)
		expect(canIUse('FileSystemManager.writeFileSync')).toBe(true)
		expect(canIUse('FileSystemManager.readFileSync')).toBe(true)
		expect(canIUse('FileSystemManager.saveFile')).toBe(true)
	})

	it('encodes ArrayBuffer payloads before forwarding writes to native', () => {
		const fsm = getFileSystemManager()
		const data = new Uint8Array([104, 105]).buffer

		fsm.writeFileSync('difile://usr/a.txt', data)

		expect(invokeAPI).toHaveBeenCalledWith('FileSystemManager.writeFileSync', {
			filePath: 'difile://usr/a.txt',
			data: {
				__diminaFileDataType: 'base64',
				__diminaFileDataBase64: 'aGk=',
			},
			encoding: undefined,
		})
	})

	it('decodes binary readFileSync results back into ArrayBuffer', () => {
		vi.mocked(invokeAPI).mockReturnValueOnce({ __diminaArrayBufferBase64: 'aGk=' })

		const result = getFileSystemManager().readFileSync('difile://usr/a.txt')

		expect(bytes(result)).toEqual([104, 105])
	})

	it('fills the caller supplied read buffer and returns ReadResult shape', () => {
		vi.mocked(invokeAPI).mockReturnValueOnce({
			bytesRead: 2,
			__diminaArrayBufferBase64: 'aGk=',
		})
		const buffer = new ArrayBuffer(4)

		const result = getFileSystemManager().readSync({ fd: 'fd-1', arrayBuffer: buffer, offset: 1, length: 2 })

		expect(result.bytesRead).toBe(2)
		expect(result.arrayBuffer).toBe(buffer)
		expect(bytes(buffer)).toEqual([0, 104, 105, 0])
		expect(result.__diminaArrayBufferBase64).toBeUndefined()
		expect(invokeAPI).toHaveBeenCalledWith('FileSystemManager.readSync', {
			fd: 'fd-1',
			offset: 1,
			length: 2,
			arrayBufferLength: 4,
		})
	})

	it('wraps stat results with Stats methods', () => {
		vi.mocked(invokeAPI).mockReturnValueOnce({
			mode: 'file',
			size: 2,
			lastAccessedTime: 1,
			lastModifiedTime: 1,
			isDirectory: false,
			isFile: true,
		})

		const stats = getFileSystemManager().statSync('difile://usr/a.txt')

		expect(stats.size).toBe(2)
		expect(stats.isFile()).toBe(true)
		expect(stats.isDirectory()).toBe(false)
	})

	it('transforms promise read results', async () => {
		vi.mocked(invokeAPI).mockResolvedValueOnce({
			data: { __diminaArrayBufferBase64: 'aGk=' },
		})

		const result = await getFileSystemManager().readFile({ filePath: 'difile://usr/a.txt' })

		expect(bytes(result.data)).toEqual([104, 105])
	})

	it('transforms promise readCompressedFile results', async () => {
		vi.mocked(invokeAPI).mockResolvedValueOnce({
			data: { __diminaArrayBufferBase64: 'aGk=' },
		})

		const result = await getFileSystemManager().readCompressedFile({
			filePath: 'difile://usr/a.br',
			compressionAlgorithm: 'br',
		})

		expect(bytes(result.data)).toEqual([104, 105])
	})

	it('decodes binary readCompressedFileSync results back into ArrayBuffer', () => {
		vi.mocked(invokeAPI).mockReturnValueOnce({ __diminaArrayBufferBase64: 'aGk=' })

		const result = getFileSystemManager().readCompressedFileSync({
			filePath: 'difile://usr/a.br',
			compressionAlgorithm: 'br',
		})

		expect(bytes(result)).toEqual([104, 105])
	})

	it('decodes binary readZipEntry item data back into ArrayBuffer', async () => {
		vi.mocked(invokeAPI).mockResolvedValueOnce({
			entries: {
				'a.txt': {
					data: { __diminaArrayBufferBase64: 'aGk=' },
					errMsg: 'FileSystemManager.readZipEntry:ok',
				},
			},
		})

		const result = await getFileSystemManager().readZipEntry({
			filePath: 'difile://usr/archive.zip',
			entries: [{ path: 'a.txt' }],
		})

		expect(bytes(result.entries['a.txt'].data)).toEqual([104, 105])
		expect(result.entries['a.txt'].errMsg).toBe('FileSystemManager.readZipEntry:ok')
	})

})
