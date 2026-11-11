import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { modDefine, modRequire } from '@dimina/common'
import { afterEach, expect, it, vi } from 'vitest'

let project, previousTarget, previousUint8, render, service, serviceLoader, renderLoader
afterEach(() => {
	render?.app?.unmount()
	if (service) { service.instances = {}; service.pageStates.clear(); service.wxmlTrees.clear() }
	if (serviceLoader) serviceLoader.staticModules = {}
	if (renderLoader) renderLoader.staticModules = {}
	globalThis.Uint8Array = previousUint8
	if (previousTarget === undefined) delete process.env.TARGET_PATH
	else process.env.TARGET_PATH = previousTarget
	if (project) fs.rmSync(project, { recursive: true, force: true })
	delete globalThis.__wxmlEventLog
	delete globalThis.__wxmlOnLoadSelection
	vi.restoreAllMocks()
})

it('uses the committed WXML tree across rendering, sync Service queries and layout queries', async () => {
	previousTarget = process.env.TARGET_PATH
	previousUint8 = globalThis.Uint8Array
	globalThis.Uint8Array = new TextEncoder().encode('').constructor
	project = fs.mkdtempSync(path.join(os.tmpdir(), 'dimina-wxml-tree-'))
	const output = path.join(project, 'out')
	process.env.TARGET_PATH = output
	globalThis.__wxmlEventLog = []
	vi.spyOn(console, 'log').mockImplementation(() => {})
	const write = (name, content) => {
		const filename = path.join(project, name)
		fs.mkdirSync(path.dirname(filename), { recursive: true })
		fs.writeFileSync(filename, content)
	}
	const pagePath = 'pages/wxml-tree/index'
	const outerPath = '/components/outer/index'
	const leafPath = '/components/leaf/index'
	write('app.json', JSON.stringify({ pages: [pagePath] }))
	write('app.js', 'App({})')
	write('project.config.json', JSON.stringify({ appid: 'wxml-tree-integration' }))
	write(pagePath + '.json', JSON.stringify({ usingComponents: { outer: outerPath, leaf: leafPath } }))
	write(pagePath + '.wxml', `<view id="wrap" class="wrapper" mark:global="page">
		<outer id="outer" class="outer" mark:entry="host" bindchange="onChange"><leaf id="slotted" class="slotted" mark:entry="slotted"/><leaf slot="first" id="named-first" class="ordered-slot"/><leaf slot="second" id="named-second" class="ordered-slot"/></outer>
		<leaf wx:for="{{rows}}" wx:key="id" id="{{item.id}}" class="card active" label="{{item.id}}"/>
	</view>`)
	write(pagePath + '.js', `Page({data:{rows:[{id:'a'},{id:'b'}]},onLoad(){globalThis.__wxmlOnLoadSelection=this.selectComponent('#wrap > .outer')?.id},onChange(e){globalThis.__wxmlEventLog.push(['page',e.target.id,e.currentTarget.id,e.mark])}})`)
	write('components/outer/index.json', JSON.stringify({ component: true, usingComponents: { leaf: leafPath } }))
	write('components/outer/index.wxml', '<view id="inside" class="inside" mark:entry="inside" mark:local="outer" bindchange="onInside"><leaf id="inner" class="leaf" mark:entry="leaf" bindchange="onLeaf"/><slot/><slot name="second"/><slot name="first"/></view><view class="other-root"/>')
	write('components/outer/index.js', `Component({options:{multipleSlots:true},methods:{onLeaf(e){globalThis.__wxmlEventLog.push(['leaf',e.target.id,e.currentTarget.id,e.mark])},onInside(e){globalThis.__wxmlEventLog.push(['inside',e.target.id,e.currentTarget.id,e.mark])}}})`)
	write('components/leaf/index.json', JSON.stringify({ component: true }))
	write('components/leaf/index.wxml', '<view class="leaf-root"><text>{{label}}</text></view>')
	write('components/leaf/index.js', 'Component({properties:{label:String}})')
	const { storeInfo, getPages } = await import('../../compiler/src/env.js')
	const { compileML } = await import('../../compiler/src/core/view-compiler.js')
	const { compileJS } = await import('../../compiler/src/core/logic-compiler.js')
	storeInfo(project)
	const pages = getPages().mainPages
	await compileML(pages, null, { completedTasks: 0 })
	const logic = await compileJS(pages, null, null, { completedTasks: 0 })
	globalThis.DiminaServiceBridge = {
		invoke: vi.fn(),
		publish: vi.fn((_id, message) => window.DiminaRenderBridge.onMessage(message)),
	}
	window.DiminaRenderBridge = {
		invoke: vi.fn(),
		publish: vi.fn(payload => globalThis.DiminaServiceBridge.onMessage(JSON.parse(payload))),
	}
	await import('../../service/src/index.js')
	await import('../src/index.js')
	service = (await import('../../service/src/core/runtime.js')).default
	serviceLoader = (await import('../../service/src/core/loader.js')).default
	render = (await import('../src/core/runtime.js')).default
	renderLoader = (await import('../src/core/loader.js')).default
	serviceLoader.staticModules = {}
	renderLoader.staticModules = {}
	service.instances = {}
	globalThis.modDefine = modDefine
	globalThis.modRequire = modRequire
	globalThis.Module = window.Module
	render.installVueRuntimeHelpers(globalThis)
	vm.runInThisContext(fs.readFileSync(path.join(output, 'main/pages_wxml-tree_index.js'), 'utf8'))
	for (const modulePath of [leafPath, outerPath, pagePath]) vm.runInThisContext(logic.find(module => module.path === modulePath).code)
	modRequire(pagePath)
	const bridgeId = 'wxml-tree-integration'
	globalThis.DiminaServiceBridge.onMessage({ type: 'pageShow', body: { bridgeId } })
	globalThis.DiminaServiceBridge.onMessage({ type: 'resourceLoaded', body: { bridgeId, pagePath, query: {} } })
	await vi.waitFor(() => expect(service.getPageState(bridgeId).ready).toBe(true))
	const page = service.getPageInstance(bridgeId)
	expect(globalThis.__wxmlOnLoadSelection).toBe('outer')
	const outer = page.selectComponent('#wrap > .outer')
	expect(outer).not.toBeNull()
	expect(page.selectComponent('.leaf')).toBeNull()
	expect(page.selectAllComponents('.card.active').map(node => node.id)).toEqual(['a', 'b'])
	expect(page.selectComponent('.outer .slotted')?.id).toBe('slotted')
	expect([...document.querySelectorAll('[id^="named-"]')].map(node => node.id)).toEqual(['named-second', 'named-first'])
	expect(page.selectAllComponents('.outer > .ordered-slot').map(node => node.id)).toEqual(['named-first', 'named-second'])
	const inner = page.selectComponent('.outer >>> .inside > .leaf')
	expect(inner?.id).toBe('inner')
	expect(outer.selectComponent('.inside > .leaf')).toBe(inner)
	inner.triggerEvent('change', {}, { bubbles: true, composed: true })
	expect(globalThis.__wxmlEventLog).toEqual([
		['leaf', 'inner', 'inner', { entry: 'leaf', local: 'outer' }],
		['inside', 'inner', 'inside', { entry: 'leaf', local: 'outer' }],
		['page', 'outer', 'outer', { entry: 'host', global: 'page' }],
	])
	globalThis.__wxmlEventLog.length = 0
	page.selectComponent('.slotted').triggerEvent('change', {}, { bubbles: true, composed: true })
	expect(globalThis.__wxmlEventLog).toEqual([
		['inside', '', 'inside', { entry: 'inside', local: 'outer' }],
		['page', 'slotted', 'outer', { entry: 'slotted', global: 'page' }],
	])
	const native = render.nativeEventInfo(document.querySelector('#inner .leaf-root'), document.querySelector('#wrap'), page.__id__)
	expect(native).toEqual({ target: { id: 'outer', dataset: {}, offsetLeft: 0, offsetTop: 0 }, mark: { entry: 'host', global: 'page' } })
	await new Promise(resolve => page.setData({ rows: [{ id: 'b' }, { id: 'a' }] }, resolve))
	expect(page.selectAllComponents('#a, .card, #b').map(node => node.id)).toEqual(['b', 'a'])
	const responses = await new Promise(resolve => page.createSelectorQuery()
		.select('#missing').boundingClientRect()
		.select('.card').fields({ id: true, size: true, properties: ['label'] })
		.selectViewport().fields({ id: true, mark: true, rect: true, size: true })
		.exec(resolve))
	expect(responses).toHaveLength(3)
	expect(responses[0]).toBeNull()
	expect(responses[1]).toEqual({ id: 'b', width: 0, height: 0, label: 'b' })
	expect(responses[2]).toEqual({ id: '', mark: {}, left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 })
	await new Promise(resolve => page.setData({ rows: [{ id: 'a' }] }, resolve))
	expect(page.selectComponent('#b')).toBeNull()
	expect(page.selectAllComponents('.card').map(node => node.id)).toEqual(['a'])
	const visible = await new Promise(resolve => page.createSelectorQuery().select('.outer >>> .leaf-root').fields({ dataset: true }).exec(resolve))
	expect(visible[0].dataset).toEqual({})
})
