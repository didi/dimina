import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

describe('目录组件样式路径', () => {
	let tempDir
	let originalTargetPath

	beforeEach(() => {
		originalTargetPath = process.env.TARGET_PATH
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'component-index-style-path-'))
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

	it('应该编译目录组件的 index.less', async () => {
		fs.writeFileSync(path.join(tempDir, 'app.json'), JSON.stringify({
			pages: ['pages/home/index'],
		}))
		fs.writeFileSync(path.join(tempDir, 'project.config.json'), JSON.stringify({
			appid: 'test-app-id',
		}))

		fs.mkdirSync(path.join(tempDir, 'pages/home'), { recursive: true })
		fs.writeFileSync(path.join(tempDir, 'pages/home/index.json'), JSON.stringify({
			usingComponents: {
				'c-nav': '/components/nav',
			},
		}))
		fs.writeFileSync(path.join(tempDir, 'pages/home/index.wxml'), '<c-nav />')
		fs.writeFileSync(path.join(tempDir, 'pages/home/index.wxss'), '')

		fs.mkdirSync(path.join(tempDir, 'components/nav'), { recursive: true })
		fs.writeFileSync(path.join(tempDir, 'components/nav/index.json'), JSON.stringify({
			component: true,
		}))
		fs.writeFileSync(path.join(tempDir, 'components/nav/index.wxml'), '<view class="nav"></view>')
		fs.writeFileSync(path.join(tempDir, 'components/nav/index.less'), '.nav { display: flex; }')

		const outputDir = path.join(tempDir, 'dist')
		fs.mkdirSync(outputDir, { recursive: true })
		process.env.TARGET_PATH = outputDir

		const { storeInfo, getPages } = await import('../src/env.js')
		storeInfo(tempDir)

		const { compileSS } = await import('../src/core/style-compiler.js')
		await compileSS(getPages().mainPages, null, { completedTasks: 0 })

		const output = fs.readFileSync(path.join(outputDir, 'main/pages_home_index.css'), 'utf-8')
		expect(output).toContain('.nav')
		expect(output).toContain('display:flex')
	})
})
