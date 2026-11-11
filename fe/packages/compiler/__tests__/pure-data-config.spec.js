import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getComponent, getPages, storeInfo } from '../src/env.js'
import { compileJS } from '../src/core/logic-compiler.js'

describe('JSON pureDataPattern compilation', () => {
	let tempDir
	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pure-data-config-'))
	})
	afterEach(() => fs.rmSync(tempDir, { recursive: true, force: true }))
	function write(relativePath, content) {
		const file = path.join(tempDir, relativePath)
		fs.mkdirSync(path.dirname(file), { recursive: true })
		fs.writeFileSync(file, content)
	}

	it('passes component, main page, and subpackage JSON patterns into registration metadata', async () => {
		write('app.json', JSON.stringify({
			pages: ['pages/home'],
			subPackages: [{ root: 'sub', pages: ['details'] }],
		}))
		write('project.config.json', '{}')
		write('app.js', 'App({})')
		write('pages/home.json', JSON.stringify({
			pureDataPattern: '^main_',
			usingComponents: { card: '/components/card' },
		}))
		write('pages/home.js', 'Component({})')
		write('sub/details.json', JSON.stringify({ pureDataPattern: '^sub_' }))
		write('sub/details.js', 'Component({})')
		write('components/card.json', JSON.stringify({ component: true, pureDataPattern: '^private_' }))
		write('components/card.js', 'Component({})')
		storeInfo(tempDir)
		const pages = getPages()
		expect(pages.mainPages[0].pureDataPattern).toBe('^main_')
		expect(Object.values(pages.subPages)[0].info[0].pureDataPattern).toBe('^sub_')
		expect(getComponent('/components/card').pureDataPattern).toBe('^private_')
		const main = await compileJS(pages.mainPages, null, null, { completedTasks: 0 })
		const sub = await compileJS(Object.values(pages.subPages)[0].info, 'sub', main, { completedTasks: 0 })
		const output = [...main, ...sub]
		for (const [id, pattern] of [
			['pages/home', '^main_'],
			['/components/card', '^private_'],
			['sub/details', '^sub_'],
		]) {
			const source = output.find(module => module.path === id)
			const sandbox = { Component() {} }
			vm.runInNewContext(source.code, sandbox)
			expect(sandbox.__extraInfo.pureDataPattern).toBe(pattern)
		}
	})
})
