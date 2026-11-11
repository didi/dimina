import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getPages, storeInfo } from '../src/env.js'
import { compileML } from '../src/core/view-compiler.js'

const vnode = (tag, props, children) => ({ tag, props, children })
const Vue = {
	Fragment: Symbol('Fragment'), openBlock() {}, resolveComponent: name => name,
	resolveDirective: name => name, createBlock: vnode, createElementBlock: vnode,
	createVNode: vnode, createElementVNode: vnode, createTextVNode: text => text,
	createCommentVNode: () => '', withDirectives: node => node, withCtx: fn => fn,
	normalizeClass: value => value, toDisplayString: value => value == null ? '' : String(value),
	renderList: (values, render) => values.map(render),
}
function load(source) {
	const definitions = new Map()
	const factories = new Map()
	const cache = new Map()
	const require = id => {
		if (!cache.has(id)) {
			const module = { exports: {} }
			cache.set(id, module)
			factories.get(id)(require, module, module.exports)
		}
		return cache.get(id).exports
	}
	vm.runInNewContext(source, {
		Vue, ...Object.fromEntries(Object.entries(Vue).map(([name, value]) => ['_' + name, value])),
		modDefine: (id, factory) => factories.set(id, factory), Module: info => definitions.set(info.path, info),
	})
	for (const id of factories.keys()) require(id)
	return definitions
}
function text(node, templates, depth = 0) {
	if (depth > 30) throw new Error('Unexpected recursive fixture template')
	if (node == null) return ''
	if (typeof node === 'function') return text(node(), templates, depth)
	if (Array.isArray(node)) return node.map(item => text(item, templates, depth)).join('')
	if (typeof node !== 'object') return String(node)
	if (node.tag === 'dd-template') {
		const props = node.props || {}
		const scope = props['dimina-template-scope']
		const id = scope ? (Object.hasOwn(scope, props.is) ? scope[props.is] : '') : 'tpl-' + props.is
		const render = templates[id]
		return render ? text(render(props.data || {}, {}), templates, depth + 1) : ''
	}
	if (node.default) return text(node.default(), templates, depth)
	return text(node.children, templates, depth)
}

describe('template lexical imports (bundled wcc contracts)', () => {
	let project
	let originalTarget
	beforeEach(() => {
		project = fs.mkdtempSync(path.join(os.tmpdir(), 'dimina-template-scope-'))
		originalTarget = process.env.TARGET_PATH
		process.env.TARGET_PATH = path.join(project, 'out')
	})
	afterEach(() => {
		if (originalTarget === undefined) delete process.env.TARGET_PATH
		else process.env.TARGET_PATH = originalTarget
		fs.rmSync(project, { recursive: true, force: true })
	})
	async function compile(files) {
		for (const [name, content] of Object.entries({
			'app.json': '{"pages":["index"]}', 'project.config.json': '{"appid":"template-scope"}', ...files,
		})) {
			const fullPath = path.join(project, name)
			fs.mkdirSync(path.dirname(fullPath), { recursive: true })
			fs.writeFileSync(fullPath, content)
		}
		storeInfo(project)
		await compileML(getPages().mainPages, null, { completedTasks: 0 })
		const module = load(fs.readFileSync(path.join(process.env.TARGET_PATH, 'main/index.js'), 'utf8')).get('index')
		return data => text(module.render(data || {}, {}), module.tplComponents)
	}
	it('keeps nested imports callable in their declaring file without re-exporting them', async () => {
		const render = await compile({
			'index.wxml': '<import src="./outer.wxml"/><template is="outer"/><template is="inner"/>',
			'outer.wxml': '<import src="./inner.wxml"/><template name="outer"><template is="inner"/></template>',
			'inner.wxml': '<template name="inner"><view>nested-marker</view></template>',
		})
		expect(render()).toBe('nested-marker')
	})
	it('separates same-named templates from different declaring files', async () => {
		const render = await compile({
			'index.wxml': '<import src="./one.wxml"/><import src="./two.wxml"/><template is="one"/><template is="two"/>',
			'one.wxml': '<template name="leaf"><view>one</view></template><template name="one"><template is="leaf"/></template>',
			'two.wxml': '<template name="leaf"><view>two</view></template><template name="two"><template is="leaf"/></template>',
		})
		expect(render()).toBe('onetwo')
	})
	it('gives local definitions priority over imported definitions', async () => {
		const render = await compile({
			'index.wxml': '<template name="card"><view>own</view></template><import src="./other.wxml"/><template is="card"/>',
			'other.wxml': '<template name="card"><view>imported</view></template>',
		})
		expect(render()).toBe('own')
	})
	it('resolves dynamic names against the last direct import', async () => {
		const render = await compile({
			'index.wxml': '<import src="./one.wxml"/><import src="./two.wxml"/><template is="{{name}}" data="{{value}}"/>',
			'one.wxml': '<template name="card"><view>first</view></template>',
			'two.wxml': '<template name="card"><view>{{value}}</view></template>',
		})
		expect(render({ name: 'card', value: 'latest' })).toBe('latest')
		expect(render({ name: 'toString' })).toBe('')
	})
	it('keeps include calls lexical and excludes their definitions from callers', async () => {
		const render = await compile({
			'index.wxml': '<template name="caller"><view>caller</view></template><include src="./part.wxml"/><template is="part"/>',
			'part.wxml': '<template name="part"><view>part</view></template><template is="part"/><template is="caller"/>',
		})
		expect(render()).toBe('part')
	})
	it('keeps caller WXS for include markup and lexical WXS for imported templates', async () => {
		const render = await compile({
			'index.wxml': '<wxs module="utils">module.exports={value:"caller"}</wxs><include src="./part.wxml"/><import src="./outer.wxml"/><template is="outer"/>',
			'part.wxml': '<wxs module="utils">module.exports={value:"excluded"}</wxs><view>{{utils.value}}</view>',
			'outer.wxml': '<import src="./inner.wxml"/><wxs module="utils">module.exports={value:"outer"}</wxs><template name="outer"><view>{{utils.value}}</view><template is="inner"/></template>',
			'inner.wxml': '<wxs module="utils">module.exports={value:"inner"}</wxs><template name="inner"><view>{{utils.value}}</view></template>',
		})
		expect(render()).toBe('callerouterinner')
	})
	it('terminates import cycles while retaining local declarations', async () => {
		const render = await compile({
			'index.wxml': '<import src="./one.wxml"/><template is="one"/>',
			'one.wxml': '<import src="./two.wxml"/><template name="one"><view>one</view><template is="two"/></template>',
			'two.wxml': '<import src="./one.wxml"/><template name="two"><view>two</view></template>',
		})
		expect(render()).toBe('onetwo')
	})
})
