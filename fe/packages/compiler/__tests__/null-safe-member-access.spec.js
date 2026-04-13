import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

describe('模板表达式空值保护', () => {
	let tempDir
	let originalTargetPath

	beforeEach(() => {
		originalTargetPath = process.env.TARGET_PATH
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'null-safe-member-access-'))
	})

	afterEach(() => {
		if (originalTargetPath) {
			process.env.TARGET_PATH = originalTargetPath
		}
		else {
			delete process.env.TARGET_PATH
		}

		if (fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true })
		}
	})

	it('应该为成员访问生成可选链', async () => {
		fs.writeFileSync(path.join(tempDir, 'app.json'), JSON.stringify({
			pages: ['pages/home/index'],
		}))
		fs.writeFileSync(path.join(tempDir, 'project.config.json'), JSON.stringify({
			appid: 'test-app-id',
		}))

		fs.mkdirSync(path.join(tempDir, 'pages/home'), { recursive: true })
		fs.writeFileSync(path.join(tempDir, 'pages/home/index.json'), JSON.stringify({
			usingComponents: {
				't-sticky': '/components/sticky',
			},
		}))
		fs.writeFileSync(path.join(tempDir, 'pages/home/index.wxml'), `
			<t-sticky z-index="{{ stickyProps.zIndex || '1' }}"></t-sticky>
		`)

		fs.mkdirSync(path.join(tempDir, 'components/sticky'), { recursive: true })
		fs.writeFileSync(path.join(tempDir, 'components/sticky/index.json'), JSON.stringify({
			component: true,
		}))
		fs.writeFileSync(path.join(tempDir, 'components/sticky/index.wxml'), '<view></view>')

		const outputDir = path.join(tempDir, 'dist')
		fs.mkdirSync(outputDir, { recursive: true })
		process.env.TARGET_PATH = outputDir

		const { storeInfo, getPages } = await import('../src/env.js')
		storeInfo(tempDir)

		const { compileML } = await import('../src/core/view-compiler.js')
		await compileML(getPages().mainPages, null, { completedTasks: 0 })

		const output = fs.readFileSync(path.join(outputDir, 'main/pages_home_index.js'), 'utf-8')
		expect(output).toContain('stickyProps?.zIndex||"1"')
		expect(output).not.toContain('stickyProps.zIndex||"1"')
	})

	it('应该为文本插值中的未声明变量和深层成员访问生成安全表达式', async () => {
		fs.writeFileSync(path.join(tempDir, 'app.json'), JSON.stringify({
			pages: ['pages/text/index'],
		}))
		fs.writeFileSync(path.join(tempDir, 'project.config.json'), JSON.stringify({
			appid: 'test-app-id',
		}))

		fs.mkdirSync(path.join(tempDir, 'pages/text'), { recursive: true })
		fs.writeFileSync(path.join(tempDir, 'pages/text/index.wxml'), `
			<view>{{test}} {{obj1.name}} {{obj2.a.b}}</view>
		`)

		const outputDir = path.join(tempDir, 'dist')
		fs.mkdirSync(outputDir, { recursive: true })
		process.env.TARGET_PATH = outputDir

		const { storeInfo, getPages } = await import('../src/env.js')
		storeInfo(tempDir)

		const { compileML } = await import('../src/core/view-compiler.js')
		await compileML(getPages().mainPages, null, { completedTasks: 0 })

		const output = fs.readFileSync(path.join(outputDir, 'main/pages_text_index.js'), 'utf-8')
		expect(output).toContain('obj1?.name')
		expect(output).toContain('obj2?.a?.b')
		expect(output).not.toContain('obj1.name')
		expect(output).not.toContain('obj2.a.b')
	})
})
