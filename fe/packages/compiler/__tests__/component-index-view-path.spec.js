import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

describe('目录组件视图编译', () => {
	let tempDir
	let originalTargetPath

	beforeEach(() => {
		originalTargetPath = process.env.TARGET_PATH
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'component-index-view-'))
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

	it('应该在页面产物中包含目录组件的 index.wxml 模块', async () => {
		fs.writeFileSync(path.join(tempDir, 'app.json'), JSON.stringify({
			pages: ['pages/home/index'],
		}))
		fs.writeFileSync(path.join(tempDir, 'project.config.json'), JSON.stringify({
			appid: 'test-app-id',
		}))

		fs.mkdirSync(path.join(tempDir, 'pages/home'), { recursive: true })
		fs.writeFileSync(path.join(tempDir, 'pages/home/index.json'), JSON.stringify({
			usingComponents: {
				nav: '/components/nav',
			},
		}))
		fs.writeFileSync(path.join(tempDir, 'pages/home/index.wxml'), '<view><nav /></view>')

		fs.mkdirSync(path.join(tempDir, 'components/nav'), { recursive: true })
		fs.writeFileSync(path.join(tempDir, 'components/nav/index.json'), JSON.stringify({
			component: true,
		}))
		fs.writeFileSync(path.join(tempDir, 'components/nav/index.wxml'), '<view class="nav">nav</view>')

		const outputDir = path.join(tempDir, 'dist')
		fs.mkdirSync(outputDir, { recursive: true })
		process.env.TARGET_PATH = outputDir

		const { storeInfo, getPages } = await import('../src/env.js')
		storeInfo(tempDir)

		const { compileML } = await import('../src/core/view-compiler.js')
		const pagesInfo = getPages()
		await compileML(pagesInfo.mainPages, null, { completedTasks: 0 })

		const outputPath = path.join(outputDir, 'main/pages_home_index.js')
		expect(fs.existsSync(outputPath)).toBe(true)

		const output = fs.readFileSync(outputPath, 'utf-8')
		expect(output).toContain('/components/nav')
	})
})
