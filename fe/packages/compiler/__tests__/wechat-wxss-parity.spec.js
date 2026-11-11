import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import postcss from 'postcss'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getPages, storeInfo } from '../src/env.js'
import { compileSS } from '../src/core/style-compiler.js'

describe('WeChat WXSS compiler parity', () => {
	let tempDir
	let oldTargetPath
	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-wxss-parity-'))
		oldTargetPath = process.env.TARGET_PATH
		process.env.TARGET_PATH = path.join(tempDir, 'output')
	})
	afterEach(() => {
		if (oldTargetPath === undefined) delete process.env.TARGET_PATH
		else process.env.TARGET_PATH = oldTargetPath
		fs.rmSync(tempDir, { recursive: true, force: true })
	})
	function write(relativePath, content) {
		const file = path.join(tempDir, relativePath)
		fs.mkdirSync(path.dirname(file), { recursive: true })
		fs.writeFileSync(file, content)
	}
	async function compile(files, options = {}) {
		write('app.json', JSON.stringify({ pages: ['pages/home'] }))
		write('project.config.json', '{}')
		for (const [file, content] of Object.entries(files)) write(file, content)
		storeInfo(tempDir)
		await compileSS(getPages().mainPages, null, { completedTasks: 0 }, options)
		return fs.readFileSync(path.join(process.env.TARGET_PATH, 'main/pages_home.css'), 'utf8')
	}

	// The bundled wcsc emits red -> imported blue -> local width in source order.
	it.each([false, true])('preserves the cascade position of imports (sourcemap=%s)', async (sourcemap) => {
		const css = await compile({
			'pages/home.wxss': '.box { width: 1px; } @import "./shared.wxss"; .box { height: 3px; }',
			'pages/shared.wxss': '.box { width: 2px; }',
		}, { sourcemap })
		const declarations = new Map()
		postcss.parse(css).walkDecls(node => declarations.set(node.prop, node.value))
		expect(Object.fromEntries(declarations)).toEqual({ width: '2px', height: '3px' })
		expect(css).not.toContain('dimina-style-import')
	})

	it('resolves a project-root WXSS import once', async () => {
		const css = await compile({
			'pages/home.wxss': '@import "/shared.wxss";',
			'shared.wxss': '.shared { width: 5px; }',
		})
		expect(css).toContain('width:5px')
	})

	it('refreshes imported CSS when recompiling the same project directory', async () => {
		const first = await compile({
			'pages/home.wxss': '@import "./shared.wxss";',
			'pages/shared.wxss': '.shared { width: 1px; }',
		})
		expect(first).toContain('width:1px')
		write('pages/shared.wxss', '.shared { width: 2px; }')
		await compileSS(getPages().mainPages, null, { completedTasks: 0 })
		const second = fs.readFileSync(path.join(process.env.TARGET_PATH, 'main/pages_home.css'), 'utf8')
		expect(second).toContain('width:2px')
	})

	it('rejects circular WXSS imports', async () => {
		await expect(compile({
			'pages/home.wxss': '@import "./shared.wxss";',
			'pages/shared.wxss': '@import "./home.wxss";',
		})).rejects.toMatchObject({ name: 'StyleCompileError', stage: 'import' })
	})
})
