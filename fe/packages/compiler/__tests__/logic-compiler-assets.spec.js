import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { storeInfo } from '../src/env.js'
import { compileJS } from '../src/core/logic-compiler.js'

describe('logic compiler asset paths', () => {
	let tempDir
	let originalCwd

	beforeEach(() => {
		originalCwd = process.cwd()
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dimina-assets-test-'))
		process.chdir(tempDir)
	})

	afterEach(() => {
		process.chdir(originalCwd)
		fs.rmSync(tempDir, { recursive: true, force: true })
		delete process.env.TARGET_PATH
	})

	it('rewrites local image string literals and copies assets', async () => {
		const targetPath = path.join(tempDir, 'dist')
		process.env.TARGET_PATH = targetPath

		fs.mkdirSync('pages/index', { recursive: true })
		fs.mkdirSync('static/home', { recursive: true })
		fs.writeFileSync('project.config.json', JSON.stringify({ appid: 'test-app' }))
		fs.writeFileSync('app.json', JSON.stringify({ pages: ['pages/index/index'] }))
		fs.writeFileSync('app.js', 'App({})')
		fs.writeFileSync('pages/index/index.json', JSON.stringify({}))
		fs.writeFileSync('static/home/card0.png', 'fake image')
		fs.writeFileSync('pages/index/index.js', `
			Page({
				data: {
					card: '/static/home/card0.png',
					name: 'card0.png',
					remote: 'https://example.com/remote.png',
				},
			})
		`)

		storeInfo(tempDir)
		const result = await compileJS([{ path: 'pages/index/index' }], null, null, { completedTasks: 0 })
		const pageModule = result.find(module => module.path === 'pages/index/index')

		expect(pageModule.code).toContain('/test-app/main/static/')
		expect(pageModule.code).toContain('_card0.png')
		expect(pageModule.code).toMatch(/name:\s*"card0\.png"/)
		expect(pageModule.code).toContain('https://example.com/remote.png')
		expect(fs.readdirSync(path.join(targetPath, 'main/static')).some(file => file.endsWith('_card0.png'))).toBe(true)
	})
})
