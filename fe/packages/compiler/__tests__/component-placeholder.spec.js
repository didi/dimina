import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import build from '../src/index.js'

describe('componentPlaceholder compilation', () => {
	let tempDir

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'component-placeholder-'))
	})

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	it('preserves nested component placeholder aliases and compiles the placeholder module', async () => {
		const workDir = path.join(tempDir, 'app')
		const outputDir = path.join(tempDir, 'out')
		const pageDir = path.join(workDir, 'pages/index')
		const shellDir = path.join(workDir, 'components/shell')
		const loadingDir = path.join(workDir, 'components/loading-card')
		fs.mkdirSync(pageDir, { recursive: true })
		fs.mkdirSync(shellDir, { recursive: true })
		fs.mkdirSync(loadingDir, { recursive: true })

		fs.writeFileSync(path.join(workDir, 'app.json'), JSON.stringify({
			appid: 'component-placeholder-app',
			pages: ['pages/index/index'],
		}))
		fs.writeFileSync(path.join(workDir, 'project.config.json'), '{}')
		fs.writeFileSync(path.join(workDir, 'app.js'), 'App({})\n')
		fs.writeFileSync(path.join(pageDir, 'index.js'), 'Page({})\n')
		fs.writeFileSync(path.join(pageDir, 'index.json'), JSON.stringify({
			usingComponents: {
				'async-page': '../../components/async-page/index',
				shell: '../../components/shell/index',
			},
			componentPlaceholder: {
				'async-page': 'shell',
			},
		}))
		fs.writeFileSync(path.join(pageDir, 'index.wxml'), '<async-page />\n')

		fs.writeFileSync(path.join(shellDir, 'index.js'), 'Component({})\n')
		fs.writeFileSync(path.join(shellDir, 'index.json'), JSON.stringify({
			component: true,
			usingComponents: {
				'async-card': '../async-card/index',
				'loading-card': '../loading-card/index',
			},
			componentPlaceholder: {
				'async-card': 'loading-card',
			},
		}))
		fs.writeFileSync(path.join(shellDir, 'index.wxml'), '<async-card value="ready" />\n')

		fs.writeFileSync(path.join(loadingDir, 'index.js'), 'Component({ properties: { value: String } })\n')
		fs.writeFileSync(path.join(loadingDir, 'index.json'), JSON.stringify({ component: true }))
		fs.writeFileSync(path.join(loadingDir, 'index.wxml'), '<view>loading {{value}}</view>\n')

		await build(outputDir, workDir, false, { sourcemap: true })

		const viewCode = fs.readFileSync(path.join(outputDir, 'main/pages_index_index.js'), 'utf8')
		expect(viewCode).toContain('componentPlaceholder: {"async-page":"shell"}')
		expect(viewCode).toContain('componentPlaceholder: {"async-card":"loading-card"}')
		expect(viewCode).toContain("path: '/components/loading-card/index'")
		expect(viewCode).toContain('resolveComponent("dd-async-card")')
	})
})
