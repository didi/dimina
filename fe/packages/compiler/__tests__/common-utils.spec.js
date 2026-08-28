import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { collectAssets, resetAssetCache, transformRpx } from '../src/common/utils.js'

describe('transformRpx', () => {
	it('does not reuse rem as the rpx transport unit', () => {
		expect(transformRpx('width:750rpx;margin-left:-7.5rpx;font-size:1rem'))
			.toBe('width:100vw;margin-left:-1vw;font-size:1rem')
	})
})

describe('collectAssets', () => {
	let tempDir

	afterEach(() => {
		vi.restoreAllMocks()
		resetAssetCache()
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

	it('copies the pathname and preserves the query string for local assets', () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compiler-assets-'))
		const workPath = path.join(tempDir, 'project')
		const targetPath = path.join(tempDir, 'output')
		const assetDir = path.join(workPath, 'pages/detail/images')
		fs.mkdirSync(assetDir, { recursive: true })
		fs.writeFileSync(path.join(assetDir, 'icon.png'), 'image')

		const result = collectAssets(
			workPath,
			'/pages/detail/index',
			'./images/icon.png?v=1#preview',
			targetPath,
			'test-app',
		)

		expect(result).toMatch(/^\/test-app\/main\/static\/.+_icon\.png\?v=1#preview$/)
		const outputName = result.split('/').pop().split('?')[0]
		expect(fs.readFileSync(path.join(targetPath, 'main/static', outputName), 'utf8')).toBe('image')
	})

	it('collects HEIC and HEIF image assets without changing their format', () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compiler-assets-'))
		const workPath = path.join(tempDir, 'project')
		const targetPath = path.join(tempDir, 'output')
		const assetDir = path.join(workPath, 'pages/detail/images')
		fs.mkdirSync(assetDir, { recursive: true })
		fs.writeFileSync(path.join(assetDir, 'photo.HEIC'), 'heic-image')
		fs.writeFileSync(path.join(assetDir, 'preview.heif'), 'heif-image')

		const heicResult = collectAssets(
			workPath,
			'/pages/detail/index',
			'./images/photo.HEIC?v=1',
			targetPath,
			'test-app',
		)
		const heifResult = collectAssets(
			workPath,
			'/pages/detail/index',
			'./images/preview.heif',
			targetPath,
			'test-app',
		)

		expect(heicResult).toMatch(/^\/test-app\/main\/static\/.+_photo\.HEIC\?v=1$/)
		expect(heifResult).toMatch(/^\/test-app\/main\/static\/.+_preview\.heif$/)
		expect(fs.readFileSync(path.join(targetPath, 'main/static', heicResult.split('/').pop().split('?')[0]), 'utf8')).toBe('heic-image')
		expect(fs.readFileSync(path.join(targetPath, 'main/static', heifResult.split('/').pop()), 'utf8')).toBe('heif-image')
	})

	it('collects WebP assets and preserves fragment-only suffixes', () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compiler-assets-'))
		const workPath = path.join(tempDir, 'project')
		const targetPath = path.join(tempDir, 'output')
		const assetDir = path.join(workPath, 'pages/detail/images')
		fs.mkdirSync(assetDir, { recursive: true })
		fs.writeFileSync(path.join(assetDir, 'photo.webp'), 'webp-image')

		const result = collectAssets(
			workPath,
			'/pages/detail/index',
			'./images/photo.webp#preview',
			targetPath,
			'test-app',
		)

		expect(result).toMatch(/^\/test-app\/main\/static\/.+_photo\.webp#preview$/)
		const outputName = result.split('/').pop().split('#')[0]
		expect(fs.readFileSync(path.join(targetPath, 'main/static', outputName), 'utf8')).toBe('webp-image')
	})

	it('copies a cached source asset into every build target', () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compiler-assets-'))
		const workPath = path.join(tempDir, 'project')
		const firstTarget = path.join(tempDir, 'output-a')
		const secondTarget = path.join(tempDir, 'output-b')
		const assetDir = path.join(workPath, 'pages/detail/images')
		fs.mkdirSync(assetDir, { recursive: true })
		fs.writeFileSync(path.join(assetDir, 'icon.png'), 'image')

		const first = collectAssets(workPath, '/pages/detail/index', './images/icon.png', firstTarget, 'test-app')
		const second = collectAssets(workPath, '/pages/detail/index', './images/icon.png', secondTarget, 'test-app')

		expect(fs.existsSync(path.join(firstTarget, 'main/static', first.split('/').pop()))).toBe(true)
		expect(fs.existsSync(path.join(secondTarget, 'main/static', second.split('/').pop()))).toBe(true)
	})

	it('copies one asset directory group only once per build target', () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compiler-assets-'))
		const workPath = path.join(tempDir, 'project')
		const targetPath = path.join(tempDir, 'output')
		const assetDir = path.join(workPath, 'pages/detail/images')
		fs.mkdirSync(assetDir, { recursive: true })
		fs.writeFileSync(path.join(assetDir, 'first.png'), 'first')
		fs.writeFileSync(path.join(assetDir, 'second.png'), 'second')
		const copySpy = vi.spyOn(fs, 'copyFileSync')

		collectAssets(workPath, '/pages/detail/index', './images/first.png', targetPath, 'test-app')
		collectAssets(workPath, '/pages/detail/index', './images/second.png', targetPath, 'test-app')

		expect(copySpy).toHaveBeenCalledTimes(2)
	})
})
