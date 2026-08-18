import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getPages, storeInfo } from '../src/env.js'
import { compileJS } from '../src/core/logic-compiler.js'

describe('logic compiler component dependency traversal', () => {
	let tempDir

	function writeProjectFile(filePath, content) {
		const fullPath = path.join(tempDir, filePath)
		fs.mkdirSync(path.dirname(fullPath), { recursive: true })
		fs.writeFileSync(fullPath, content)
	}

	function prepareProject(usingComponents) {
		writeProjectFile('app.json', JSON.stringify({ pages: ['pages/dependency/index'] }))
		writeProjectFile('app.js', 'App({})')
		writeProjectFile('project.config.json', JSON.stringify({ appid: 'logic-component-traversal' }))
		writeProjectFile('pages/dependency/index.json', JSON.stringify({ usingComponents }))
		writeProjectFile('pages/dependency/index.js', 'Page({})')
	}

	function writeComponent(componentPath, usingComponents = {}) {
		writeProjectFile(`${componentPath}.json`, JSON.stringify({
			component: true,
			usingComponents,
		}))
		writeProjectFile(`${componentPath}.js`, 'Component({})')
	}

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logic-component-traversal-'))
	})

	afterEach(() => {
		vi.restoreAllMocks()
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	it('silently closes a mutual component dependency cycle', async () => {
		prepareProject({ 'node-a': '/components/cycle-a' })
		writeComponent('components/cycle-a', { 'node-b': '/components/cycle-b' })
		writeComponent('components/cycle-b', { 'node-a': '/components/cycle-a' })
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

		storeInfo(tempDir)
		const result = await compileJS(getPages().mainPages, null, null, { completedTasks: 0 })
		const paths = result.map(item => item.path)

		expect(paths).toContain('/components/cycle-a')
		expect(paths).toContain('/components/cycle-b')
		expect(warn).not.toHaveBeenCalled()
	})

	it('compiles every module in a deep acyclic component chain', async () => {
		const depth = 24
		prepareProject({ 'depth-0': '/components/logic-depth-0' })
		for (let index = 0; index < depth; index++) {
			const usingComponents = index < depth - 1
				? { [`depth-${index + 1}`]: `/components/logic-depth-${index + 1}` }
				: {}
			writeComponent(`components/logic-depth-${index}`, usingComponents)
		}
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

		storeInfo(tempDir)
		const result = await compileJS(getPages().mainPages, null, null, { completedTasks: 0 })
		const paths = result.map(item => item.path)

		expect(paths).toContain(`/components/logic-depth-${depth - 1}`)
		expect(warn).not.toHaveBeenCalled()
	})
})
