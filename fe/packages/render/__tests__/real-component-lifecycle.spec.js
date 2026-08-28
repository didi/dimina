import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { modDefine, modRequire } from '@dimina/common'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('compiled page lifecycle with repeated real components', () => {
	const pagePath = 'pages/real-lifecycle/index'
	const componentPath = '/components/real-lifecycle-probe/index'
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
			},
		}))
		writeProjectFile(`${pagePath}.wxml`, `
			<view>
				<lifecycle-probe instance-id="probe-a" />
				<lifecycle-probe instance-id="probe-b" />
			</view>
		`)
		writeProjectFile(`${pagePath}.js`, `
			function recordPage(event) {
				globalThis.__realComponentLifecycleLogs.push({ scope: 'page', event })
			}
			Page({
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
				properties: { instanceId: String },
				lifetimes: {
					created() { recordComponent(this, 'created') },
					attached() { recordComponent(this, 'attached') },
					ready() { recordComponent(this, 'ready') },
					detached() { recordComponent(this, 'detached') },
				},
				pageLifetimes: {
					show() { recordComponent(this, 'show') },
					hide() { recordComponent(this, 'hide') },
					resize() { recordComponent(this, 'resize') },
					routeDone() { recordComponent(this, 'routeDone') },
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
		expect(compiledView).toContain('"instance-id":"probe-a"')
		expect(compiledView).toContain('"instance-id":"probe-b"')

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

		for (const modulePath of [componentPath, pagePath]) {
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

		globalThis.DiminaServiceBridge.onMessage({ type: 'pageHide', body: { bridgeId } })
		globalThis.DiminaServiceBridge.onMessage({
			type: 'pageResize',
			body: { bridgeId, size: { width: 320, height: 640 } },
		})
		globalThis.DiminaServiceBridge.onMessage({ type: 'pageRouteDone', body: { bridgeId } })
		globalThis.DiminaServiceBridge.onMessage({ type: 'pageUnload', body: { bridgeId } })

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
