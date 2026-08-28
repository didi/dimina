import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hotpathSpies = vi.hoisted(() => ({
	cheerioLoad: vi.fn(),
	esbuildTransform: vi.fn(),
	postcssPlugins: vi.fn(),
}))

vi.mock('cheerio', async (importOriginal) => {
	const actual = await importOriginal()
	return {
		...actual,
		load(...args) {
			hotpathSpies.cheerioLoad(args[0])
			return actual.load(...args)
		},
	}
})

vi.mock('esbuild', async (importOriginal) => {
	const actual = await importOriginal()
	return {
		...actual,
		transform(...args) {
			hotpathSpies.esbuildTransform(...args)
			return actual.transform(...args)
		},
	}
})

vi.mock('postcss', async (importOriginal) => {
	const actual = await importOriginal()
	const wrapped = (...args) => {
		hotpathSpies.postcssPlugins(args[0]?.map(plugin => plugin?.postcssPlugin).filter(Boolean) || [])
		return actual.default(...args)
	}
	Object.assign(wrapped, actual.default)
	return { ...actual, default: wrapped }
})

describe('compiler CPU hot paths', () => {
	let tempDir
	let outputDir
	let originalTargetPath

	beforeEach(() => {
		vi.clearAllMocks()
		originalTargetPath = process.env.TARGET_PATH
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compiler-hotpaths-'))
		outputDir = path.join(tempDir, 'dist')
		fs.mkdirSync(outputDir, { recursive: true })
		process.env.TARGET_PATH = outputDir
	})

	afterEach(() => {
		if (originalTargetPath) process.env.TARGET_PATH = originalTargetPath
		else delete process.env.TARGET_PATH
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	function writeFile(relativePath, content) {
		const filePath = path.join(tempDir, relativePath)
		fs.mkdirSync(path.dirname(filePath), { recursive: true })
		fs.writeFileSync(filePath, content)
	}

	it('parses each template source once and minifies all view modules in one esbuild call', async () => {
		writeFile('app.json', JSON.stringify({ pages: ['pages/index'] }))
		writeFile('project.config.json', JSON.stringify({ appid: 'hotpath-view' }))
		writeFile('pages/index.json', JSON.stringify({
			usingComponents: { card: '/components/card' },
		}))
		writeFile('pages/index.wxml', [
			'<include src="./fragment.wxml" />',
			'<card><text slot="content">A</text><text slot="content">B</text></card>',
		].join('\n'))
		writeFile('pages/fragment.wxml', '<view wx:for="{{items}}" wx:if="{{item.visible}}">{{item.name}}</view>')
		writeFile('components/card.json', JSON.stringify({ component: true }))
		writeFile('components/card.wxml', '<view><slot name="content" /></view>')

		const { getPages, storeInfo } = await import('../src/env.js')
		storeInfo(tempDir)
		const { compileML } = await import('../src/core/view-compiler.js')
		await compileML(getPages().mainPages, null, { completedTasks: 0 })

		expect(hotpathSpies.cheerioLoad).toHaveBeenCalledTimes(3)
		expect(hotpathSpies.esbuildTransform).toHaveBeenCalledTimes(1)
		const bundleSource = hotpathSpies.esbuildTransform.mock.calls[0][0]
		expect(bundleSource).toContain("modDefine('pages/index'")
		expect(bundleSource).toContain("modDefine('/components/card'")
	})

	it('runs external-class and prefix processing in one PostCSS pass', async () => {
		writeFile('app.json', JSON.stringify({ pages: ['pages/index'] }))
		writeFile('project.config.json', JSON.stringify({ appid: 'hotpath-style' }))
		writeFile('pages/index.json', '{}')
		writeFile('pages/index.wxss', 'view { display: flex; user-select: none; }')

		const { getPages, storeInfo } = await import('../src/env.js')
		storeInfo(tempDir)
		const { compileSS } = await import('../src/core/style-compiler.js')
		await compileSS(getPages().mainPages, null, { completedTasks: 0 })

		const postprocessPasses = hotpathSpies.postcssPlugins.mock.calls
			.map(([plugins]) => plugins)
			.filter(plugins => plugins.includes('dimina-external-class') || plugins.includes('autoprefixer'))
		expect(postprocessPasses).toEqual([
			expect.arrayContaining(['dimina-external-class', 'autoprefixer']),
		])
	})
})
