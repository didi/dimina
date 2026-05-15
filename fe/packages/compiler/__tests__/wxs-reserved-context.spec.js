import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

describe('wxs 保留上下文字段', () => {
	let tempDir
	let originalTargetPath

	beforeEach(() => {
		originalTargetPath = process.env.TARGET_PATH
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wxs-reserved-context-'))
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

	it('应该使用局部变量而不是给 _ctx._ 赋值', async () => {
		fs.writeFileSync(path.join(tempDir, 'app.json'), JSON.stringify({
			pages: ['pages/home/index'],
		}))
		fs.writeFileSync(path.join(tempDir, 'project.config.json'), JSON.stringify({
			appid: 'test-app-id',
		}))

		fs.mkdirSync(path.join(tempDir, 'pages/home'), { recursive: true })
		fs.writeFileSync(path.join(tempDir, 'pages/home/index.json'), JSON.stringify({}))
		fs.writeFileSync(path.join(tempDir, 'pages/home/index.wxml'), `
			<wxs module="_">
				function cls(name) {
					return name
				}
				module.exports = {
					cls: cls
				}
			</wxs>
			<view class="{{_.cls('home')}}"></view>
		`)

		const outputDir = path.join(tempDir, 'dist')
		fs.mkdirSync(outputDir, { recursive: true })
		process.env.TARGET_PATH = outputDir

		const { storeInfo, getPages } = await import('../src/env.js')
		storeInfo(tempDir)

		const { compileML } = await import('../src/core/view-compiler.js')
		await compileML(getPages().mainPages, null, { completedTasks: 0 })

		const output = fs.readFileSync(path.join(outputDir, 'main/pages_home_index.js'), 'utf-8')
		expect(output).toContain('o("_")')
		expect(output).toContain('.cls("home")')
		expect(output).not.toContain('_ctx._=')
		expect(output).not.toContain('_.=')
	})
})
