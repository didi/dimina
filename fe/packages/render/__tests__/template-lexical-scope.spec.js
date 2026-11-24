import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import * as Vue from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Template from '../../components/src/component/template/Template.vue'
import loader from '../src/core/loader'
import runtime from '../src/core/runtime'

let project, originalTarget, originalUint8Array, app, root
beforeEach(() => {
	originalTarget = process.env.TARGET_PATH
	originalUint8Array = globalThis.Uint8Array
	globalThis.Uint8Array = new TextEncoder().encode('').constructor
	project = fs.mkdtempSync(path.join(os.tmpdir(), 'dimina-template-dom-'))
	process.env.TARGET_PATH = path.join(project, 'out')
	runtime.templateComponentRegistries = new Map()
})
afterEach(() => {
	app?.unmount()
	root?.remove()
	globalThis.Uint8Array = originalUint8Array
	if (originalTarget === undefined) delete process.env.TARGET_PATH
	else process.env.TARGET_PATH = originalTarget
	fs.rmSync(project, { recursive: true, force: true })
	vi.restoreAllMocks()
})
async function compile(files) {
	for (const [name, content] of Object.entries({
		'app.json': '{"pages":["index"]}', 'project.config.json': '{"appid":"template-dom"}', ...files,
	})) {
		const target = path.join(project, name)
		fs.mkdirSync(path.dirname(target), { recursive: true })
		fs.writeFileSync(target, content)
	}
	const { getPages, storeInfo } = await import('../../compiler/src/env.js')
	const { compileML } = await import('../../compiler/src/core/view-compiler.js')
	storeInfo(project)
	await compileML(getPages().mainPages, null, { completedTasks: 0 })
	const definitions = new Map(), factories = new Map(), cache = new Map()
	const require = id => {
		if (!cache.has(id)) {
			const module = { exports: {} }
			cache.set(id, module)
			factories.get(id)(require, module, module.exports)
		}
		return cache.get(id).exports
	}
	vm.runInNewContext(fs.readFileSync(path.join(process.env.TARGET_PATH, 'main/index.js'), 'utf8'), {
		Vue, ...Object.fromEntries(Object.entries(Vue).map(([name, value]) => ['_' + name, value])),
		modDefine: (id, factory) => factories.set(id, factory), Module: moduleInfo => definitions.set(moduleInfo.path, { moduleInfo }),
	})
	for (const id of factories.keys()) require(id)
	vi.spyOn(loader, 'getModuleByPath').mockImplementation(id => definitions.get(id))
	return definitions
}
function mount(component) {
	app = Vue.createApp(component)
	app.component('dd-template', Template)
	app.component('dd-view', { setup: (_, { slots }) => () => Vue.h('div', slots.default?.()) })
	app.component('dd-component-host', { setup: (_, { slots }) => () => Vue.h('div', slots.default?.()) })
	root = document.createElement('div')
	document.body.append(root)
	app.mount(root)
}

describe('compiled lexical templates in the real render runtime', () => {
	it('renders nested lexical imports and updates dynamic template data without leaking names', async () => {
		const modules = await compile({
			'index.wxml': '<import src="./outer.wxml"/><template is="{{chosen}}" data="{{value}}"/><template is="inner"/>',
			'outer.wxml': '<import src="./inner.wxml"/><template name="outer"><template is="inner" data="{{value}}"/></template>',
			'inner.wxml': '<template name="inner"><view>{{value}}</view></template>',
		})
		const registry = runtime.createTemplateComponents('index', 'template-dom')
		const state = Vue.reactive({ chosen: 'outer', value: 'first' })
		mount({ setup() { Vue.provide('dimina-template-components', registry); return state }, render: modules.get('index').moduleInfo.render })
		await Vue.nextTick()
		expect(root.textContent).toBe('first')
		state.value = 'updated'
		await Vue.nextTick()
		expect(root.textContent).toBe('updated')
		state.chosen = 'toString'
		await Vue.nextTick()
		expect(root.textContent).toBe('')
	})
	it('keeps a shared template scope visible when a v-for alias has the same name', async () => {
		const modules = await compile({
			'index.wxml': '<import src="./shared.wxml"/>'
				+ '<template is="card" data="{{value: outer}}"/>'
				+ '<template wx:for="{{rows}}" wx:for-item="__diminaTemplateScope0" wx:for-index="require" wx:key="id"'
				+ ' is="{{__diminaTemplateScope0.name}}" data="{{value: __diminaTemplateScope0.value}}"/>',
			'shared.wxml': '<template name="card"><view>{{value}}</view></template>',
		})
		const registry = runtime.createTemplateComponents('index', 'template-dom')
		mount({
			setup() {
				Vue.provide('dimina-template-components', registry)
				return { outer: 'outside', rows: [{ id: 1, name: 'card', value: 'inside' }] }
			},
			render: modules.get('index').moduleInfo.render,
		})
		expect(root.textContent).toBe('outsideinside')
	})
	it('keeps template custom-component registries local to their consuming module', async () => {
		const modules = await compile({
			'index.json': '{"usingComponents":{"left":"/left","right":"/right"}}',
			'index.wxml': '<view><left/><right/></view>',
			'left.json': '{"component":true,"usingComponents":{"label":"/left-label"}}',
			'right.json': '{"component":true,"usingComponents":{"label":"/right-label"}}',
			'left-label.json': '{"component":true}',
			'right-label.json': '{"component":true}',
			'left-label.wxml': '<view>left</view>',
			'right-label.wxml': '<view>right</view>',
			'left.wxml': '<import src="./shared.wxml"/><template is="card"/>',
			'right.wxml': '<import src="./shared.wxml"/><template is="card"/>',
			'shared.wxml': '<template name="card"><label/></template>',
		})
		const leftModule = modules.get('/left').moduleInfo
		const rightModule = modules.get('/right').moduleInfo
		const [templateId] = Object.keys(leftModule.tplComponents)
		expect(leftModule.tplComponents[templateId]).toBe(rightModule.tplComponents[templateId])
		vi.spyOn(runtime, 'createComponent').mockImplementation(path => ({ 'dd-label': { render: () => Vue.h('span', path) } }))
		const wrap = module => ({
			setup() {
				Vue.provide('dimina-template-components', runtime.createTemplateComponents(module.path, 'template-context'))
			},
			render: module.render,
		})
		mount({ render: () => Vue.h('div', [Vue.h(wrap(leftModule)), Vue.h(wrap(rightModule))]) })
		await Vue.nextTick()
		expect(root.textContent).toBe('/left/right')
	})
})
