import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { getPages, storeInfo } from '../src/env.js'
import { compileML } from '../src/core/view-compiler.js'

let project, originalTarget
beforeEach(() => {
	project = fs.mkdtempSync(path.join(os.tmpdir(), 'dimina-scroll-config-'))
	originalTarget = process.env.TARGET_PATH
	process.env.TARGET_PATH = path.join(project, 'out')
})
afterEach(() => {
	if (originalTarget === undefined) delete process.env.TARGET_PATH
	else process.env.TARGET_PATH = originalTarget
	fs.rmSync(project, { recursive: true, force: true })
})
it('emits global defaults, page overrides, and independent subpackage configuration', async () => {
	const defaults = { enablePullDownRefresh: true, onReachBottomDistance: 80, backgroundColor: '#eee', backgroundTextStyle: 'light' }
	const files = {
		'app.json': JSON.stringify({ pages: ['index', 'override'], window: defaults, subPackages: [{ root: 'pkg', pages: ['detail'], independent: true }] }),
		'project.config.json': '{"appid":"page-scroll-config"}',
		'index.wxml': '<view>inherited</view>',
		'override.wxml': '<view>override</view>',
		'override.json': '{"enablePullDownRefresh":false,"onReachBottomDistance":0}',
		'pkg/detail.wxml': '<view>subpackage</view>',
	}
	for (const [name, content] of Object.entries(files)) {
		const file = path.join(project, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content)
	}
	storeInfo(project)
	const { mainPages, subPages } = getPages()
	await compileML(mainPages, null, { completedTasks: 0 })
	for (const [root, subPackage] of Object.entries(subPages)) {
		await compileML(subPackage.info, root, { completedTasks: 0 })
	}
	function readConfig(file) {
		let info; const factories = new Map()
		vm.runInNewContext(fs.readFileSync(path.join(process.env.TARGET_PATH, file), 'utf8'), {
			modDefine: (id, factory) => factories.set(id, factory), Module: value => { info = value },
		})
		for (const factory of factories.values()) factory(() => {}, { exports: {} }, {})
		return info.pageConfig === undefined ? undefined : JSON.parse(JSON.stringify(info.pageConfig))
	}
	expect(readConfig('main/index.js')).toEqual(defaults)
	expect(readConfig('main/override.js')).toEqual({ ...defaults, enablePullDownRefresh: false, onReachBottomDistance: 0 })
	expect(readConfig('sub_pkg/pkg_detail.js')).toEqual(defaults)
})
