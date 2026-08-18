import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { collectAssets, transformRpx } from '../src/common/utils.js'

describe('transformRpx', () => {
	it('does not reuse rem as the rpx transport unit', () => {
		expect(transformRpx('width:750rpx;margin-left:-7.5rpx;font-size:1rem'))
			.toBe('width:100vw;margin-left:-1vw;font-size:1rem')
	})
})

describe('collectAssets', () => {
	let tempDir

	afterEach(() => {
		if (tempDir) {
			fs.rmSync(tempDir, { recursive: true, force: true })
		}
	})

	it('resolves relative assets below the project root when the module path starts with a slash', () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compiler-assets-'))
		const workPath = path.join(tempDir, 'project')
		const targetPath = path.join(tempDir, 'output')
		const assetDir = path.join(workPath, 'pages/detail/images')
		fs.mkdirSync(assetDir, { recursive: true })
		fs.writeFileSync(path.join(assetDir, 'icon.png'), 'image')

		const result = collectAssets(
			workPath,
			'/pages/detail/index',
			'./images/icon.png',
			targetPath,
			'test-app',
		)

		expect(result).toMatch(/^\/test-app\/main\/static\/.+_icon\.png$/)
		expect(fs.existsSync(path.join(targetPath, 'main/static', result.split('/').pop()))).toBe(true)
	})

	it('does not prepend the project root twice for absolute filesystem module paths', () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compiler-assets-'))
		const workPath = path.join(tempDir, 'project')
		const targetPath = path.join(tempDir, 'output')
		const pagePath = path.join(workPath, 'pages/canvas/index.js')
		fs.mkdirSync(path.dirname(pagePath), { recursive: true })
		fs.writeFileSync(path.join(path.dirname(pagePath), 'car.png'), 'image')

		const result = collectAssets(workPath, pagePath, './car.png', targetPath, 'test-app')

		expect(result).toMatch(/^\/test-app\/main\/static\/.+_car\.png$/)
	})

	it('clamps imported-template traversal at the mini-program project root', () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compiler-assets-'))
		const workPath = path.join(tempDir, 'project')
		const targetPath = path.join(tempDir, 'output')
		fs.mkdirSync(path.join(workPath, 'image'), { recursive: true })
		fs.writeFileSync(path.join(workPath, 'image/icon.png'), 'image')

		const result = collectAssets(
			workPath,
			'/page/common/foot',
			'../../../../image/icon.png',
			targetPath,
			'test-app',
		)

		expect(result).toMatch(/^\/test-app\/main\/static\/.+_icon\.png$/)
	})
})
