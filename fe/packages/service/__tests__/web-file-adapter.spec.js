import { describe, expect, it, vi } from 'vitest'

vi.mock('@dimina/common', async importOriginal => ({ ...await importOriginal(), isWebWorker: true }))
vi.mock('@/api/common', () => ({ invokeAPI: vi.fn() }))
import { invokeAPI } from '@/api/common'
import { getFileSystemManager, VIRTUAL_FILE_PREFIX } from '../src/api/core/file'

describe('Web runtime FileSystemManager adapter', () => {
	it('makes a synchronous MP4 write immediately readable by the async decoder without a container round trip', async () => {
		const filesystem = getFileSystemManager()
		const root = `${VIRTUAL_FILE_PREFIX}usr/runtime-test`
		const path = `${root}/video.mp4`
		filesystem.mkdirSync(root)
		filesystem.writeFileSync(path, new Uint8Array([0, 1, 2, 255]), 'utf8')
		filesystem.accessSync(path)
		const { data } = await filesystem.readFile({ filePath: path })
		expect([...new Uint8Array(data)]).toEqual([0, 1, 2, 255])
		const success = vi.fn()
		await filesystem.readFile({ filePath: path, success })
		expect(success).toHaveBeenCalledWith(expect.objectContaining({ data: expect.any(ArrayBuffer) }))
		expect(filesystem.readdirSync(root)).toEqual(['video.mp4'])
		filesystem.unlinkSync(path)
		expect(() => filesystem.readFileSync(path)).toThrow('no such')
		expect(invokeAPI).not.toHaveBeenCalled()
	})
})
