import { describe, expect, it } from 'vitest'
import { createRuntimeFiles } from '../src/api/core/file/web-runtime-files'

describe('Worker runtime files', () => {
	it('supports libpag synchronous binary writes with async-reader-compatible owned bytes', () => {
		const files = createRuntimeFiles('difile://usr')
		files.mkdir('difile://usr/video/')
		const source = new Uint8Array([0, 1, 255])
		files.write('difile://usr/video/data.mp4', source, 'utf8')
		source[0] = 100
		const data = new Uint8Array(files.read('difile://usr/video/data.mp4'))
		expect([...data]).toEqual([0, 1, 255])
		data[0] = 42
		expect([...new Uint8Array(files.read('difile://usr/video/data.mp4', undefined, 1, 2))]).toEqual([1, 255])
		expect(files.readdir('difile://usr/video/')).toEqual(['data.mp4'])
		files.unlink('difile://usr/video/data.mp4')
		expect(() => files.access('difile://usr/video/data.mp4')).toThrow('no such')
	})
	it('rejects traversal, missing parents, excessive storage and invalid encodings', () => {
		const files = createRuntimeFiles('difile://usr')
		for (const path of ['/etc/test', 'difile://usr/%2e%2e/test', 'difile://usr/a//b', 'difile://usr/a\\b']) expect(() => files.write(path, '')).toThrow()
		expect(() => files.write('difile://usr/missing/file', '')).toThrow('directory')
		files.mkdir('difile://usr/a/b', true)
		files.write('difile://usr/a/b/text', '中文')
		expect(files.read('difile://usr/a/b/text', 'utf8')).toBe('中文')
		expect(() => files.read('difile://usr/a/b/text', 'invalid')).toThrow('UTF-8')
		expect(() => files.read('difile://usr/a/b/text', undefined, -1)).toThrow('range')
		expect(() => files.write('difile://usr/large', new ArrayBuffer(128 * 1024 * 1024 + 1))).toThrow('128 MiB')
	})
})
