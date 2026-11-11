import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getPages, storeInfo } from '../src/env.js'
import { compileML } from '../src/core/view-compiler.js'

// Execute the emitted AMD factories and render expressions, including WXS require.
// These Vue helpers retain vnode values without mounting a browser or resolving components.
const vnode = (tag, props, children) => ({ tag, props, children })
const Vue = {
	Fragment: Symbol('Fragment'),
	openBlock() {},
	resolveComponent: name => name,
	resolveDirective: name => name,
	createBlock: vnode,
	createElementBlock: vnode,
	createVNode: vnode,
	createElementVNode: vnode,
	createTextVNode: text => text,
	createCommentVNode: () => '',
	withDirectives: node => node,
	withCtx: fn => fn,
	normalizeClass: value => value,
	toDisplayString: value => value == null ? '' : String(value),
	renderList: (values, render) => values.map(render),
}

function loadBundle(source) {
	const factories = new Map()
	const exports = new Map()
	const modules = new Map()
	const require = id => {
		if (!exports.has(id)) {
			const module = { exports: {} }
			exports.set(id, module)
			const factory = factories.get(id)
			if (!factory) throw new Error('Missing emitted module: ' + id)
			factory(require, module, module.exports)
		}
		return exports.get(id).exports
	}
	vm.runInNewContext(source, {
		Vue,
		...Object.fromEntries(Object.entries(Vue).map(([name, helper]) => ['_' + name, helper])),
		modDefine: (id, factory) => factories.set(id, factory),
		Module: definition => modules.set(definition.path, definition),
	})
	for (const id of factories.keys()) require(id)
	return modules
}

function template(page, name) {
	const id = Object.keys(page.tplComponents).find(key => key.startsWith(`tpl-${name}-`))
	return page.tplComponents[id]
}

function text(node) {
	if (node == null) return ''
	if (typeof node === 'function') return text(node())
	if (node.default) return text(node.default())
	if (typeof node !== 'object') return String(node)
	if (Array.isArray(node)) return node.map(text).join('')
	return text(node.children)
}

describe('WeChat WXML compiler parity', () => {
	let tempDir
	let oldTargetPath
	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-wxml-parity-'))
		oldTargetPath = process.env.TARGET_PATH
		process.env.TARGET_PATH = path.join(tempDir, 'output')
	})
	afterEach(() => {
		vi.restoreAllMocks()
		if (oldTargetPath === undefined) delete process.env.TARGET_PATH
		else process.env.TARGET_PATH = oldTargetPath
		fs.rmSync(tempDir, { recursive: true, force: true })
	})
	function write(relativePath, content) {
		const file = path.join(tempDir, relativePath)
		fs.mkdirSync(path.dirname(file), { recursive: true })
		fs.writeFileSync(file, content)
	}
	async function compile(files, pages = ['pages/home']) {
		write('app.json', JSON.stringify({ pages }))
		write('project.config.json', JSON.stringify({ appid: 'wechat-parity' }))
		for (const [file, content] of Object.entries(files)) write(file, content)
		storeInfo(tempDir)
		await compileML(getPages().mainPages, null, { completedTasks: 0 })
		return pages.map(page => loadBundle(fs.readFileSync(path.join(process.env.TARGET_PATH, 'main', page.replaceAll('/', '_') + '.js'), 'utf8')))
	}

	// Reference: the bundled wcc gives each file its own f_[file] WXS namespace.
	it('isolates same-named inline WXS across pages and components', async () => {
		const [first, second] = await compile({
			'pages/home.json': JSON.stringify({ usingComponents: { 'info-card': '/components/card' } }),
			'pages/home.wxml': '<wxs module="utils">module.exports = { value: "page" };</wxs><view>{{utils.value}}</view><info-card/>',
			'pages/other.wxml': '<wxs module="utils">module.exports = { value: "other" };</wxs><view>{{utils.value}}</view>',
			'components/card.json': JSON.stringify({ component: true }),
			'components/card.wxml': '<wxs module="utils">module.exports = { value: "component" };</wxs><view>{{utils.value}}</view>',
		}, ['pages/home', 'pages/other'])
		expect(text(first.get('pages/home').render({}, {}))).toBe('page')
		const card = first.get('/components/card')
		const child = card.render({}, {})
		expect(text(child.children.default())).toBe('component')
		expect(text(second.get('pages/other').render({}, {}))).toBe('other')
	})

	it('keeps component WXS aliases out of parent page data', async () => {
		const [modules] = await compile({
			'pages/home.json': JSON.stringify({ usingComponents: { 'info-card': '/components/card' } }),
			'pages/home.wxml': '<view>{{utils.value}}</view><info-card/>',
			'components/card.json': JSON.stringify({ component: true }),
			'components/card.wxml': '<wxs module="utils">module.exports = { value: "component-script" };</wxs><view>{{utils.value}}</view>',
		})
		expect(text(modules.get('pages/home').render({ utils: { value: 'page-data' } }, {}))).toBe('page-data')
	})

	it('binds imported templates to WXS in their declaring files', async () => {
		const [modules] = await compile({
			'pages/home.wxml': '<import src="../templates/left.wxml"/><import src="../templates/right.wxml"/><wxs module="utils">module.exports = { value: "page" };</wxs><view>{{utils.value}}</view>',
			'templates/left.wxml': '<wxs module="utils">module.exports = { value: "left" };</wxs><template name="left"><view>{{utils.value}}</view></template>',
			'templates/right.wxml': '<wxs module="utils">module.exports = { value: "right" };</wxs><template name="right"><view>{{utils.value}}</view></template>',
		})
		const page = modules.get('pages/home')
		expect(text(page.render({}, {}))).toBe('page')
		expect(text(template(page, 'left')({}, {}))).toBe('left')
		expect(text(template(page, 'right')({}, {}))).toBe('right')
	})

	it('resolves inline WXS require relative to its declaring WXML file', async () => {
		const [modules] = await compile({
			'pages/home.wxml': '<wxs module="utils">module.exports = require("./shared/first.wxs");</wxs><view>{{utils.value}}</view>',
			'pages/shared/first.wxs': 'module.exports = require("./second.wxs");',
			'pages/shared/second.wxs': 'module.exports = { value: "dependency" };',
		})
		expect(text(modules.get('pages/home').render({}, {}))).toBe('dependency')
	})

	it('expands nested extensionless includes relative to each declaring file', async () => {
		const [modules] = await compile({
			'pages/home.wxml': '<include src="../partials/outer"/>',
			'partials/outer.wxml': '<include src="./inner/leaf"/>',
			'partials/inner/leaf.wxml': '<view>leaf-marker</view>',
		})
		expect(text(modules.get('pages/home').render({}, {}))).toBe('leaf-marker')
	})

	it('retains conditions and excludes template/WXS nodes through nested includes', async () => {
		const [modules] = await compile({
			'pages/home.wxml': '<wxs module="utils">module.exports = { value: "caller" };</wxs><include src="../partials/outer" wx:if="{{visible}}"/>',
			'partials/outer.wxml': '<include src="./inner/leaf" wx:if="{{nested}}"/>',
			'partials/inner/leaf.wxml': '<wxs module="utils">module.exports = { value: "excluded" };</wxs><template name="hidden"><view>excluded-template</view></template><view>{{utils.value}}</view>',
		})
		const page = modules.get('pages/home')
		expect(text(page.render({ visible: false, nested: true }, {}))).toBe('')
		expect(text(page.render({ visible: true, nested: false }, {}))).toBe('')
		expect(text(page.render({ visible: true, nested: true }, {}))).toBe('caller')
	})

	it('keeps imports inside included files relative to those files', async () => {
		const [modules] = await compile({
			'pages/home.wxml': '<include src="../partials/outer"/>',
			'partials/outer.wxml': '<import src="./templates/card"/><view>included</view>',
			'partials/templates/card.wxml': '<template name="card"><view>relative-template</view></template>',
		})
		const page = modules.get('pages/home')
		expect(text(page.render({}, {}))).toBe('included')
		expect(text(template(page, 'card')({}, {}))).toBe('relative-template')
	})

	it('stops cyclic include edges without dropping surrounding content', async () => {
		const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const [modules] = await compile({
			'pages/home.wxml': '<view>root</view><include src="../partials/cycle"/>',
			'partials/cycle.wxml': '<view>child</view><include src="../pages/home"/>',
		})
		expect(text(modules.get('pages/home').render({}, {}))).toBe('rootchildroot')
		expect(warning).toHaveBeenCalledWith(expect.stringContaining('Circular include skipped'))
	})

	it('refreshes WXML and WXS caches when recompiling the same project directory', async () => {
		const [first] = await compile({
			'pages/home.wxml': '<import src="../templates/card.wxml"/><wxs module="inline">module.exports = { value: "first-inline" };</wxs><wxs src="../shared/value.wxs" module="external"/><view>{{inline.value}}|{{external.value}}</view>',
			'shared/value.wxs': 'module.exports = { value: "first-external" };',
			'templates/card.wxml': '<template name="card"><view>first-template</view></template>',
		})
		expect(text(first.get('pages/home').render({}, {}))).toBe('first-inline|first-external')
		write('pages/home.wxml', '<import src="../templates/card.wxml"/><wxs module="inline">module.exports = { value: "next-inline" };</wxs><wxs src="../shared/value.wxs" module="external"/><view>{{inline.value}}|{{external.value}}</view>')
		write('shared/value.wxs', 'module.exports = { value: "next-external" };')
		write('templates/card.wxml', '<template name="card"><view>next-template</view></template>')
		await compileML(getPages().mainPages, null, { completedTasks: 0 })
		const second = loadBundle(fs.readFileSync(path.join(process.env.TARGET_PATH, 'main/pages_home.js'), 'utf8'))
		const page = second.get('pages/home')
		expect(text(page.render({}, {}))).toBe('next-inline|next-external')
		expect(text(template(page, 'card')({}, {}))).toBe('next-template')
	})

	it('retains cached external WXS dependency graphs for later pages', async () => {
		const [first, second] = await compile({
			'pages/home.wxml': '<wxs src="../shared/outer.wxs" module="utils"/><view>{{utils.value}}</view>',
			'pages/other.wxml': '<wxs src="../shared/outer.wxs" module="other"/><view>{{other.value}}</view>',
			'shared/outer.wxs': 'module.exports = require("./middle.wxs");',
			'shared/middle.wxs': 'module.exports = require("./inner.wxs");',
			'shared/inner.wxs': 'module.exports = { value: "shared-dependency" };',
		}, ['pages/home', 'pages/other'])
		expect(text(first.get('pages/home').render({}, {}))).toBe('shared-dependency')
		expect(text(second.get('pages/other').render({}, {}))).toBe('shared-dependency')
	})

	it.each(['index', 'itemId'])('uses static wx:key=%s as an item property', async (field) => {
		const [modules] = await compile({
			'pages/home.wxml': '<view wx:for="{{items}}" wx:key="' + field + '">{{index}}</view>',
		})
		const items = [{ [field]: 'first' }, { [field]: 'second' }]
		const tree = modules.get('pages/home').render({ items }, {})
		expect(tree.children.map(node => node.props.key)).toEqual(['first', 'second'])
	})

	it('retains primitive wx:key=*this values without throwing on null items', async () => {
		const [modules] = await compile({
			'pages/home.wxml': '<view wx:for="{{items}}" wx:key="*this">{{index}}</view>',
		})
		const tree = modules.get('pages/home').render({ items: [1, '1', null] }, {})
		expect(tree.children.map(node => node.props.key)).toEqual([1, '1', null])
	})
})
