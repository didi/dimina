import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { modDefine, modRequire } from '@dimina/common'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('compiled page lifecycle with repeated real components', () => {
	const pagePath = 'pages/real-lifecycle/index'
	const componentPath = '/components/real-lifecycle-probe/index'
	const nestedPath = '/components/nested-probe/index'
	const relationParentPath = '/components/relation-parent/index'
	let projectDir
	let outputDir
	let originalTargetPath
	let originalUint8Array
	let renderLoader
	let renderRuntime
	let serviceLoader
	let serviceRuntime

	function writeProjectFile(filePath, content) {
		const fullPath = path.join(projectDir, filePath)
		fs.mkdirSync(path.dirname(fullPath), { recursive: true })
		fs.writeFileSync(fullPath, content)
	}

	function evaluateLogicModule(module) {
		vm.runInThisContext(module.code, {
			filename: path.join(projectDir, `${module.path.replace(/^\//, '')}.js`),
		})
	}

	beforeEach(() => {
		originalTargetPath = process.env.TARGET_PATH
		originalUint8Array = globalThis.Uint8Array
		// Vitest's jsdom realm can expose a different Uint8Array constructor than
		// Node's TextEncoder. esbuild requires both to share the same realm.
		globalThis.Uint8Array = new TextEncoder().encode('').constructor
		projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dimina-real-lifecycle-'))
		outputDir = path.join(projectDir, 'dist')
		process.env.TARGET_PATH = outputDir
		globalThis.__realComponentLifecycleLogs = []
		globalThis.__realComponentPropertyLogs = []
		globalThis.__realRelationLogs = []
		document.body.innerHTML = ''
		vi.spyOn(console, 'log').mockImplementation(() => {})
	})

	afterEach(() => {
		renderRuntime?.app?.unmount()
		if (serviceRuntime) {
			serviceRuntime.instances = {}
			serviceRuntime.pageStates.clear()
		}
		if (serviceLoader) {
			serviceLoader.staticModules = {}
		}
		if (renderLoader) {
			renderLoader.staticModules = {}
		}
		delete globalThis.__realComponentLifecycleLogs
		delete globalThis.__realComponentPropertyLogs
		delete globalThis.__realRelationLogs
		delete globalThis.__extraInfo
		delete globalThis.modDefine
		delete globalThis.modRequire
		delete globalThis.Module
		delete globalThis.DiminaServiceBridge
		delete window.DiminaRenderBridge
		globalThis.Uint8Array = originalUint8Array
		if (originalTargetPath === undefined) delete process.env.TARGET_PATH
		else process.env.TARGET_PATH = originalTargetPath
		fs.rmSync(projectDir, { recursive: true, force: true })
		vi.restoreAllMocks()
	})

	it('runs a complete isolated lifecycle for every same-path component instance', async () => {
		writeProjectFile('app.json', JSON.stringify({ pages: [pagePath] }))
		writeProjectFile('app.js', 'App({})')
		writeProjectFile('project.config.json', JSON.stringify({ appid: 'real-lifecycle-regression' }))
		writeProjectFile(`${pagePath}.json`, JSON.stringify({
			usingComponents: {
				'lifecycle-probe': componentPath,
				'nested-probe': nestedPath,
				'relation-parent': relationParentPath,
			},
		}))
		writeProjectFile(`${pagePath}.wxml`, `
			<view>
				<relation-parent>
				<lifecycle-probe wx:for="{{rows}}" wx:for-item="row" wx:for-index="position"
					wx:key="id" instance-id="{{row.id}}" mixed="{{row.value * 10 + offset + position * 0}}"
					picked="{{row.values[selected]}}" />
				</relation-parent>
				<view wx:for="{{groups}}" wx:key="id">
					<nested-probe wx:for="{{item.rows}}" wx:key="id" label="{{item.id}}"
						value="{{item.value + index}}" />
				</view>
			</view>
		`)
		writeProjectFile(`${pagePath}.js`, `
			function recordPage(event) {
				globalThis.__realComponentLifecycleLogs.push({ scope: 'page', event })
			}
			Page({
				data: {
					rows: [{ id: 'probe-a', value: 1, values: [5, 6] }, { id: 'probe-b', value: 2, values: [7, 8] }],
					offset: 0,
					selected: 0,
					groups: [{ id: 'g-a', rows: [{ id: 'nested-a', value: 1 }] },
						{ id: 'g-b', rows: [{ id: 'nested-b', value: 2 }] }],
				},
				onLoad() { recordPage('onLoad') },
				onShow() { recordPage('onShow') },
				onReady() { recordPage('onReady') },
				onHide() { recordPage('onHide') },
				onResize() { recordPage('onResize') },
				onUnload() { recordPage('onUnload') },
			})
		`)
		writeProjectFile('components/real-lifecycle-probe/index.json', JSON.stringify({ component: true }))
		writeProjectFile('components/real-lifecycle-probe/index.wxml', '<view>{{instanceId}}</view>')
		writeProjectFile('components/real-lifecycle-probe/index.js', `
			function recordComponent(component, event) {
				globalThis.__realComponentLifecycleLogs.push({
					scope: 'component',
					event,
					instance: component.__id__,
					label: component.properties.instanceId,
				})
			}
			Component({
				properties: {
					instanceId: String,
					mixed: { type: Number, observer(value, old) {
						globalThis.__realComponentPropertyLogs.push([this.data.instanceId, 'mixed', value, old])
					} },
					picked: { type: Number, observer(value, old) {
						globalThis.__realComponentPropertyLogs.push([this.data.instanceId, 'picked', value, old])
					} },
				},
				observers: {
					'mixed, picked'(mixed, picked) {
						globalThis.__realComponentPropertyLogs.push([this.data.instanceId, 'data', mixed, picked])
					},
				},
				relations: {
					'../relation-parent/index': {
						type: 'parent',
						linked() { globalThis.__realRelationLogs.push(['child linked', this.data.instanceId]) },
						linkChanged() { globalThis.__realRelationLogs.push(['child changed', this.data.instanceId]) },
						unlinked() { globalThis.__realRelationLogs.push(['child unlinked', this.data.instanceId]) },
					},
				},
				lifetimes: {
					moved() { globalThis.__realRelationLogs.push(['child moved', this.data.instanceId]) },
					created() { recordComponent(this, 'created') },
					attached() {
						recordComponent(this, 'attached')
						globalThis.__realRelationLogs.push(['child attached', this.data.instanceId])
					},
					ready() {
						recordComponent(this, 'ready')
						globalThis.__realRelationLogs.push(['child ready', this.data.instanceId])
					},
					detached() {
						recordComponent(this, 'detached')
						globalThis.__realRelationLogs.push(['child detached', this.data.instanceId])
					},
				},
				pageLifetimes: {
					show() { recordComponent(this, 'show') },
					hide() { recordComponent(this, 'hide') },
					resize() { recordComponent(this, 'resize') },
					routeDone() { recordComponent(this, 'routeDone') },
				},
			})
		`)

		writeProjectFile('components/relation-parent/index.json', JSON.stringify({ component: true }))
		writeProjectFile('components/relation-parent/index.wxml', '<view><slot /></view>')
		writeProjectFile('components/relation-parent/index.js', `
			const path = '../real-lifecycle-probe/index'
			Component({
				relations: {
					[path]: {
						type: 'child',
						linked(child) { globalThis.__realRelationLogs.push(['parent linked', child.data.instanceId]) },
						linkChanged(child) {
							globalThis.__realRelationLogs.push(['parent changed', child.data.instanceId,
								this.getRelationNodes(path).map(node => node.data.instanceId)])
						},
						unlinked(child) { globalThis.__realRelationLogs.push(['parent unlinked', child.data.instanceId]) },
					},
				},
				lifetimes: {
					attached() { globalThis.__realRelationLogs.push(['parent attached']) },
					ready() { globalThis.__realRelationLogs.push(['parent ready', this.getRelationNodes(path).map(node => node.data.instanceId)]) },
					detached() { globalThis.__realRelationLogs.push(['parent detached']) },
				},
			})
		`)

		writeProjectFile('components/nested-probe/index.json', JSON.stringify({ component: true }))
		writeProjectFile('components/nested-probe/index.wxml', '<view>{{label}}:{{value}}</view>')
		writeProjectFile('components/nested-probe/index.js', `
			Component({
				properties: { label: String, value: Number },
				observers: {
					value(value) { globalThis.__realComponentPropertyLogs.push([this.data.label, 'nested', value]) },
				},
			})
		`)

		const { getPages, storeInfo } = await import('../../compiler/src/env.js')
		const { compileJS } = await import('../../compiler/src/core/logic-compiler.js')
		const { compileML } = await import('../../compiler/src/core/view-compiler.js')
		storeInfo(projectDir)
		const pages = getPages()
		await compileML(pages.mainPages, null, { completedTasks: 0 })
		const logicModules = await compileJS(pages.mainPages, null, null, { completedTasks: 0 })
		const compiledView = fs.readFileSync(
			path.join(outputDir, 'main/pages_real-lifecycle_index.js'),
			'utf8',
		)

		globalThis.DiminaServiceBridge = {
			invoke: vi.fn(),
			publish: vi.fn((_bridgeId, message) => {
				window.DiminaRenderBridge.onMessage(message)
				return Promise.resolve()
			}),
		}
		window.DiminaRenderBridge = {
			invoke: vi.fn(),
			publish: vi.fn((payload) => {
				globalThis.DiminaServiceBridge.onMessage(JSON.parse(payload))
			}),
		}

		await import('../../service/src/index.js')
		serviceLoader = (await import('../../service/src/core/loader.js')).default
		serviceRuntime = (await import('../../service/src/core/runtime.js')).default
		await import('../src/index.js')
		renderLoader = (await import('../src/core/loader.js')).default
		renderRuntime = (await import('../src/core/runtime.js')).default

		serviceLoader.staticModules = {}
		serviceRuntime.instances = {}
		serviceRuntime.pageStates.clear()
		renderLoader.staticModules = {}
		globalThis.modDefine = modDefine
		globalThis.modRequire = modRequire
		globalThis.Module = window.Module
		renderRuntime.installVueRuntimeHelpers(globalThis)
		vm.runInThisContext(compiledView, {
			filename: path.join(outputDir, 'main/pages_real-lifecycle_index.js'),
		})

		for (const modulePath of [componentPath, nestedPath, relationParentPath, pagePath]) {
			const module = logicModules.find(candidate => candidate.path === modulePath)
			expect(module, `missing compiled logic module ${modulePath}`).toBeDefined()
			evaluateLogicModule(module)
		}
		modRequire(pagePath)

		const bridgeId = 'bridge-real-lifecycle'
		globalThis.DiminaServiceBridge.onMessage({ type: 'pageShow', body: { bridgeId } })
		globalThis.DiminaServiceBridge.onMessage({
			type: 'resourceLoaded',
			body: { bridgeId, pagePath, query: {}, scene: 1001 },
		})

		await vi.waitFor(() => {
			expect(globalThis.__realComponentLifecycleLogs).toContainEqual({
				scope: 'page',
				event: 'onReady',
			})
		})
		expect(document.body.textContent).toContain('probe-a')
		expect(document.body.textContent).toContain('probe-b')
		const mountedComponents = Object.values(serviceRuntime.instances[bridgeId]).filter(instance => (
			instance.is === componentPath
		))
		expect(mountedComponents).toHaveLength(2)
		expect(new Set(mountedComponents.map(instance => instance.__id__)).size).toBe(2)
		expect(mountedComponents.map(instance => instance.properties.instanceId).sort()).toEqual(['probe-a', 'probe-b'])

		const relationLogs = globalThis.__realRelationLogs
		expect(relationLogs).toEqual([
			['parent attached'],
			['child attached', 'probe-a'], ['parent linked', 'probe-a'], ['child linked', 'probe-a'],
			['child attached', 'probe-b'], ['parent linked', 'probe-b'], ['child linked', 'probe-b'],
			['parent ready', ['probe-a', 'probe-b']], ['child ready', 'probe-a'], ['child ready', 'probe-b'],
		])
		relationLogs.length = 0
		const firstUpdateMessage = window.DiminaRenderBridge.publish.mock.calls.length

		const page = Object.values(serviceRuntime.instances[bridgeId]).find(instance => instance.is === pagePath)
		const relationParent = Object.values(serviceRuntime.instances[bridgeId]).find(instance => instance.is === relationParentPath)
		for (const child of mountedComponents) {
			expect(child.selectOwnerComponent()).toBe(page)
			expect(child.getRelationNodes('../relation-parent/index')).toEqual([relationParent])
		}
		const propertyLogs = globalThis.__realComponentPropertyLogs
		const setData = data => new Promise(resolve => page.setData(data, resolve))
		propertyLogs.length = 0
		await setData({ 'rows[0].note': 'unrelated', 'rows[0].values[1]': 9 })
		expect(propertyLogs).toEqual([])
		await setData({ 'rows[0].value': 1, 'rows[0].values[0]': 5 })
		expect(propertyLogs).toEqual([['probe-a', 'data', 10, 5]])

		propertyLogs.length = 0
		await Promise.all([setData({ offset: 1 }), setData({ offset: 2 }), setData({ offset: 2 })])
		expect(propertyLogs).toEqual([
			['probe-a', 'data', 11, 5], ['probe-a', 'mixed', 11, 10],
			['probe-b', 'data', 21, 7], ['probe-b', 'mixed', 21, 20],
			['probe-a', 'data', 12, 5], ['probe-a', 'mixed', 12, 11],
			['probe-b', 'data', 22, 7], ['probe-b', 'mixed', 22, 21],
			['probe-a', 'data', 12, 5], ['probe-b', 'data', 22, 7],
		])

		propertyLogs.length = 0
		await setData({ 'rows[1].value': 3, selected: 1 })
		expect(propertyLogs).toEqual([
			['probe-a', 'data', 12, 9], ['probe-a', 'picked', 9, 5],
			['probe-b', 'data', 32, 8], ['probe-b', 'mixed', 32, 22], ['probe-b', 'picked', 8, 7],
		])

		propertyLogs.length = 0
		expect(relationLogs).toEqual([])
		const updateMessages = window.DiminaRenderBridge.publish.mock.calls.slice(firstUpdateMessage)
		expect(updateMessages.some(([payload]) => JSON.parse(payload).type === 'mT')).toBe(false)
		const [a, b] = page.data.rows
		await Promise.all([setData({ rows: [b, a] }), setData({ 'rows[0].value': 3 })])
		expect(propertyLogs).toEqual([
			['probe-b', 'data', 32, 8], ['probe-a', 'data', 12, 9], ['probe-b', 'data', 32, 8],
		])

		expect(relationLogs).toEqual([
			['child moved', 'probe-b'],
			['parent changed', 'probe-b', ['probe-b', 'probe-a']],
			['child changed', 'probe-b'],
		])
		relationLogs.length = 0

		propertyLogs.length = 0
		const [groupA, groupB] = page.data.groups
		await Promise.all([
			setData({ groups: [groupB, groupA] }),
			setData({ 'groups[0].rows[0].value': 3 }),
			setData({ 'groups[0].rows[0].value': 3 }),
		])
		expect(propertyLogs).toEqual([
			['nested-b', 'nested', 2], ['nested-a', 'nested', 1],
			['nested-b', 'nested', 3], ['nested-b', 'nested', 3],
		])

		globalThis.DiminaServiceBridge.onMessage({ type: 'pageHide', body: { bridgeId } })
		globalThis.DiminaServiceBridge.onMessage({
			type: 'pageResize',
			body: { bridgeId, size: { width: 320, height: 640 } },
		})
		globalThis.DiminaServiceBridge.onMessage({ type: 'pageRouteDone', body: { bridgeId } })
		globalThis.DiminaServiceBridge.onMessage({ type: 'pageUnload', body: { bridgeId } })

		expect(relationLogs).toEqual([
			['child detached', 'probe-b'], ['parent unlinked', 'probe-b'], ['child unlinked', 'probe-b'],
			['child detached', 'probe-a'], ['parent unlinked', 'probe-a'], ['child unlinked', 'probe-a'],
			['parent detached'],
		])

		const logs = globalThis.__realComponentLifecycleLogs
		const created = logs.filter(log => log.scope === 'component' && log.event === 'created')
		expect(created).toHaveLength(2)
		expect(new Set(created.map(log => log.instance)).size).toBe(2)

		const instanceLabels = new Map(
			logs
				.filter(log => log.scope === 'component' && log.event === 'attached')
				.map(log => [log.instance, log.label]),
		)
		expect([...instanceLabels.values()].sort()).toEqual(['probe-a', 'probe-b'])

		for (const instanceId of instanceLabels.keys()) {
			expect(
				logs
					.filter(log => log.scope === 'component' && log.instance === instanceId)
					.map(log => log.event),
			).toEqual(['created', 'attached', 'show', 'ready', 'hide', 'resize', 'routeDone', 'detached'])
		}
		expect(
			logs.filter(log => log.scope === 'page').map(log => log.event),
		).toEqual(['onLoad', 'onShow', 'onReady', 'onHide', 'onResize', 'onUnload'])

		const eventIndex = (scope, event, instance) => logs.findIndex(log => (
			log.scope === scope && log.event === event && (!instance || log.instance === instance)
		))
		for (const event of ['hide', 'resize']) {
			const pageEvent = `on${event[0].toUpperCase()}${event.slice(1)}`
			for (const instanceId of instanceLabels.keys()) {
				expect(eventIndex('component', event, instanceId)).toBeLessThan(eventIndex('page', pageEvent))
			}
		}
		for (const instanceId of instanceLabels.keys()) {
			expect(eventIndex('component', 'show', instanceId)).toBeLessThan(eventIndex('component', 'ready', instanceId))
			expect(eventIndex('component', 'ready', instanceId)).toBeLessThan(eventIndex('page', 'onReady'))
			expect(eventIndex('page', 'onUnload')).toBeLessThan(eventIndex('component', 'detached', instanceId))
		}
		expect(serviceRuntime.instances[bridgeId]).toBeUndefined()
	}, 30_000)
})
