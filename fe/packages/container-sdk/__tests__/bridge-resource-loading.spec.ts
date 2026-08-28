import type { MiniApp } from '../src/pages/miniApp/miniApp.js'
import type { WebView } from '../src/pages/webview/webview.js'
import { describe, expect, it, vi } from 'vitest'
import { Bridge } from '../src/core/bridge.js'

type BridgeCtorOptions = ConstructorParameters<typeof Bridge>[0]

interface FakeJSCore {
	postMessage: ReturnType<typeof vi.fn>
	notifyServiceReady: ReturnType<typeof vi.fn>
	onWorkerFailure?: ReturnType<typeof vi.fn>
}

/**
 * 桩造一个 Bridge：测试只关心消息协议，不需要真实的 appId/configInfo/isRoot 等
 * BridgeOptions 必填字段，这里用 unknown 收窄一次性桥接，避免每个用例各自断言类型。
 */
function createBridge(opts: { jscore: FakeJSCore } & Record<string, unknown>): Bridge {
	return new Bridge(opts as unknown as BridgeCtorOptions)
}

function createStartableBridge() {
	const jscore = {
		postMessage: vi.fn(),
		notifyServiceReady: vi.fn(),
		onWorkerFailure: vi.fn(() => vi.fn()),
	}
	const bridge = createBridge({
		jscore,
		appId: 'app-startup-ready',
		pagePath: 'pages/index/index',
		root: 'main',
		scene: 1001,
		query: {},
	})
	bridge.id = 'bridge-startup-ready'
	bridge.webview = { postMessage: vi.fn() } as unknown as WebView
	bridge.parent = { getHostEnvSnapshot: vi.fn(() => ({})) } as unknown as MiniApp
	return { bridge, jscore }
}

function acknowledgeResources(bridge: Bridge) {
	for (const [source, type] of [
		['service', 'serviceResourceLoaded'],
		['render', 'renderResourceLoaded'],
	] as const) {
		bridge.messageInvoke(source, {
			type,
			target: 'service',
			body: { bridgeId: bridge.id, resourceLoadId: bridge.resourceLoadId },
		})
	}
}

describe('Bridge resource loading protocol', () => {
	it('keeps startup pending after resources load and resolves only for the current domReady', async () => {
		const { bridge } = createStartableBridge()
		let resolved = false
		const ready = bridge.startAndWait().then(() => {
			resolved = true
		})
		const currentResourceLoadId = bridge.resourceLoadId

		acknowledgeResources(bridge)
		await Promise.resolve()
		expect(bridge.isResourceLoaded()).toBe(true)
		expect(bridge.isStartupReady()).toBe(false)
		expect(resolved).toBe(false)

		bridge.messageInvoke('render', {
			type: 'domReady',
			target: 'container',
			body: { bridgeId: bridge.id },
		})
		bridge.messageInvoke('render', {
			type: 'domReady',
			target: 'container',
			body: { bridgeId: bridge.id, resourceLoadId: 'load-stale' },
		})
		await Promise.resolve()
		expect(resolved).toBe(false)

		bridge.messageInvoke('render', {
			type: 'domReady',
			target: 'container',
			body: { bridgeId: bridge.id, resourceLoadId: currentResourceLoadId },
		})
		await ready
		expect(bridge.isStartupReady()).toBe(true)
		expect(resolved).toBe(true)
	})

	it('rejects startup when render loading fails before domReady', async () => {
		const { bridge } = createStartableBridge()
		const ready = bridge.startAndWait()

		bridge.messageInvoke('render', {
			type: 'renderResourceLoadFailed',
			target: 'service',
			body: {
				bridgeId: bridge.id,
				resourceLoadId: bridge.resourceLoadId,
				errors: ['render failed'],
			},
		})

		await expect(ready).rejects.toThrow('render failed')
	})

	it('rejects a pending startup when the bridge is destroyed', async () => {
		const { bridge } = createStartableBridge()
		const ready = bridge.startAndWait()
		bridge.destroy()
		await expect(ready).rejects.toThrow('bridge was destroyed before startup became ready')
	})

	it('resets readiness and rejects the previous waiter when startup is superseded', async () => {
		const { bridge } = createStartableBridge()
		const firstReady = bridge.startAndWait()
		const firstRejected = expect(firstReady).rejects.toThrow('startup was superseded')
		const firstResourceLoadId = bridge.resourceLoadId
		acknowledgeResources(bridge)

		const secondReady = bridge.startAndWait()
		const secondResourceLoadId = bridge.resourceLoadId
		await firstRejected
		expect(secondResourceLoadId).not.toBe(firstResourceLoadId)
		expect(bridge.isResourceLoaded()).toBe(false)
		expect(bridge.isStartupReady()).toBe(false)

		bridge.messageInvoke('render', {
			type: 'domReady',
			target: 'container',
			body: { bridgeId: bridge.id, resourceLoadId: firstResourceLoadId },
		})
		acknowledgeResources(bridge)
		bridge.messageInvoke('render', {
			type: 'domReady',
			target: 'container',
			body: { bridgeId: bridge.id, resourceLoadId: secondResourceLoadId },
		})

		await secondReady
		expect(bridge.isStartupReady()).toBe(true)
	})

	it('rejects startup when domReady never arrives', async () => {
		vi.useFakeTimers()
		try {
			const { bridge } = createStartableBridge()
			const ready = bridge.startAndWait()
			acknowledgeResources(bridge)
			const assertion = expect(ready).rejects.toThrow('startup ready timed out')
			await vi.runAllTimersAsync()
			await assertion
		}
		finally {
			vi.useRealTimers()
		}
	})

	it('flushes the queued pageShow after resourceLoaded in service message order', () => {
		const jscore = { postMessage: vi.fn(), notifyServiceReady: vi.fn() }
		const bridge = createBridge({
			jscore,
			pagePath: 'pages/index/index',
			scene: 1001,
			query: {},
		})
		bridge.id = 'bridge-visible'
		bridge.resourceLoadId = 'load-visible'

		bridge.pageShow()
		expect(jscore.postMessage).not.toHaveBeenCalled()

		bridge.messageInvoke('service', {
			type: 'serviceResourceLoaded',
			target: 'service',
			body: { bridgeId: bridge.id, resourceLoadId: bridge.resourceLoadId },
		})
		bridge.messageInvoke('render', {
			type: 'renderResourceLoaded',
			target: 'service',
			body: { bridgeId: bridge.id, resourceLoadId: bridge.resourceLoadId },
		})

		expect(jscore.postMessage.mock.calls.map(([message]) => message.type)).toEqual([
			'resourceLoaded',
			'pageShow',
		])
	})

	it('suppresses duplicate visibility notifications after the page becomes visible', () => {
		const jscore = { postMessage: vi.fn(), notifyServiceReady: vi.fn() }
		const bridge = createBridge({
			jscore,
			pagePath: 'pages/index/index',
			scene: 1001,
			query: {},
		})
		bridge.id = 'bridge-hidden'
		bridge.resourceLoadId = 'load-hidden'

		bridge.pageShow()
		bridge.messageInvoke('service', {
			type: 'serviceResourceLoaded',
			target: 'service',
			body: { bridgeId: bridge.id, resourceLoadId: bridge.resourceLoadId },
		})
		bridge.messageInvoke('render', {
			type: 'renderResourceLoaded',
			target: 'service',
			body: { bridgeId: bridge.id, resourceLoadId: bridge.resourceLoadId },
		})
		bridge.pageHide()
		bridge.pageHide()

		expect(jscore.postMessage.mock.calls.map(([message]) => message.type)).toEqual([
			'resourceLoaded',
			'pageShow',
			'pageHide',
		])
	})

	it('does not emit pageHide for a page that never became visible', () => {
		const jscore = { postMessage: vi.fn(), notifyServiceReady: vi.fn() }
		const bridge = createBridge({
			jscore,
			appId: 'app-1',
			pagePath: 'pages/index/index',
			root: '.',
			scene: 1001,
			query: {},
		})
		bridge.id = 'bridge-early-hidden'
		bridge.webview = { postMessage: vi.fn() } as unknown as WebView
		bridge.parent = { getHostEnvSnapshot: vi.fn(() => ({})) } as unknown as MiniApp

		bridge.pageHide()
		bridge.start()
		expect(jscore.postMessage.mock.calls[0][0]).toMatchObject({
			type: 'loadResource',
			body: {
				scene: 1001,
				query: {},
			},
		})
		bridge.messageInvoke('service', {
			type: 'serviceResourceLoaded',
			target: 'service',
			body: { bridgeId: bridge.id, resourceLoadId: bridge.resourceLoadId },
		})
		bridge.messageInvoke('render', {
			type: 'renderResourceLoaded',
			target: 'service',
			body: { bridgeId: bridge.id, resourceLoadId: bridge.resourceLoadId },
		})

		expect(jscore.postMessage.mock.calls.map(([message]) => message.type)).toEqual([
			'loadResource',
			'resourceLoaded',
		])
		expect(bridge.sentPageVisible).toBe(false)
	})

	it('uses the per-app resource base for both render and service loaders', () => {
		const jscore = { postMessage: vi.fn(), notifyServiceReady: vi.fn() }
		const bridge = createBridge({
			jscore,
			appId: 'remote-app',
			pagePath: 'pages/index/index',
			root: 'main',
			scene: 1001,
			query: {},
			runtimeType: 'game',
		})
		bridge.webview = { postMessage: vi.fn() } as unknown as WebView
		bridge.parent = {
			getHostEnvSnapshot: vi.fn(() => ({})),
			getResourceBaseUrl: vi.fn(() => 'https://cdn.example.com/apps/'),
		} as unknown as MiniApp

		bridge.start()

		expect(bridge.webview!.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'loadResource',
			body: expect.objectContaining({
				baseUrl: 'https://cdn.example.com/apps/',
				runtimeType: 'game',
			}),
		}))
		expect(jscore.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'loadResource',
			body: expect.objectContaining({
				baseUrl: 'https://cdn.example.com/apps/',
				runtimeType: 'game',
			}),
		}))
	})

	it('forwards render failures without marking resources as loaded', () => {
		const jscore = { postMessage: vi.fn(), notifyServiceReady: vi.fn() }
		const bridge = createBridge({
			jscore,
			pagePath: 'pages/index/index',
			scene: 1001,
			query: {},
		})
		bridge.id = 'bridge-failure'
		bridge.resourceLoadId = 'load-failure'
		bridge.serviceResource = true
		bridge.renderResource = true

		bridge.messageInvoke('render', {
			type: 'renderResourceLoadFailed',
			target: 'service',
			body: {
				bridgeId: bridge.id,
				resourceLoadId: bridge.resourceLoadId,
				errors: ['script failed'],
			},
		})

		expect(bridge.renderResource).toBe(false)
		expect(bridge.isResourceLoaded()).toBe(false)
		expect(jscore.postMessage).toHaveBeenCalledWith({
			type: 'resourceLoadFailed',
			body: {
				bridgeId: bridge.id,
				resourceLoadId: 'load-failure',
				pagePath: 'pages/index/index',
				scene: 1001,
				query: {},
				errors: ['script failed'],
			},
		})
	})

	it('forwards resourceLoaded only once when a side repeats its acknowledgement', () => {
		const jscore = { postMessage: vi.fn(), notifyServiceReady: vi.fn() }
		const bridge = createBridge({
			jscore,
			pagePath: 'pages/index/index',
			scene: 1001,
			query: {},
		})
		bridge.id = 'bridge-duplicate-resource'
		bridge.resourceLoadId = 'load-duplicate'

		for (const type of ['serviceResourceLoaded', 'renderResourceLoaded', 'renderResourceLoaded']) {
			bridge.messageInvoke('render', {
				type,
				target: 'service',
				body: { bridgeId: bridge.id, resourceLoadId: bridge.resourceLoadId },
			})
		}

		expect(jscore.postMessage.mock.calls.map(([message]) => message.type)).toEqual(['resourceLoaded'])
	})

	it('rejects resource acknowledgements that omit the current load generation', () => {
		const jscore = { postMessage: vi.fn(), notifyServiceReady: vi.fn() }
		const bridge = createBridge({
			jscore,
			pagePath: 'pages/index/index',
			scene: 1001,
			query: {},
		})
		bridge.id = 'bridge-missing-load-id'
		bridge.resourceLoadId = 'load-current'

		for (const type of ['serviceResourceLoaded', 'renderResourceLoaded']) {
			bridge.messageInvoke('render', {
				type,
				target: 'service',
				body: { bridgeId: bridge.id },
			})
		}

		expect(bridge.isResourceLoaded()).toBe(false)
		expect(jscore.postMessage).not.toHaveBeenCalled()
	})

	it('drops late resource acknowledgements after an in-flight bridge is destroyed', () => {
		const jscore = { postMessage: vi.fn(), notifyServiceReady: vi.fn() }
		const bridge = createBridge({
			jscore,
			pagePath: 'pages/index/index',
			scene: 1001,
			query: {},
		})
		bridge.id = 'bridge-destroyed-during-load'
		bridge.resourceLoadId = 'load-destroyed'
		const destroyedResourceLoadId = bridge.resourceLoadId
		bridge.pageShow()
		bridge.destroy()

		bridge.messageInvoke('service', {
			type: 'serviceResourceLoaded',
			target: 'service',
			body: { bridgeId: bridge.id, resourceLoadId: destroyedResourceLoadId },
		})
		bridge.messageInvoke('render', {
			type: 'renderResourceLoaded',
			target: 'service',
			body: { bridgeId: bridge.id, resourceLoadId: destroyedResourceLoadId },
		})

		expect(jscore.postMessage).not.toHaveBeenCalled()
	})

	it('ignores resource acknowledgements from an earlier start on a reused bridge', () => {
		const jscore = { postMessage: vi.fn(), notifyServiceReady: vi.fn() }
		const bridge = createBridge({
			jscore,
			appId: 'app-1',
			pagePath: 'pages/index/index',
			root: '.',
			scene: 1001,
			query: {},
		})
		bridge.id = 'bridge-reused-load'
		bridge.webview = { postMessage: vi.fn() } as unknown as WebView
		bridge.parent = { getHostEnvSnapshot: vi.fn(() => ({})) } as unknown as MiniApp

		bridge.start()
		const staleResourceLoadId = bridge.resourceLoadId
		bridge.resetStatus()
		bridge.start()
		const currentResourceLoadId = bridge.resourceLoadId
		jscore.postMessage.mockClear()

		for (const type of ['serviceResourceLoaded', 'renderResourceLoaded']) {
			bridge.messageInvoke('render', {
				type,
				target: 'service',
				body: { bridgeId: bridge.id, resourceLoadId: staleResourceLoadId },
			})
		}
		expect(jscore.postMessage).not.toHaveBeenCalled()

		for (const type of ['serviceResourceLoaded', 'renderResourceLoaded']) {
			bridge.messageInvoke('render', {
				type,
				target: 'service',
				body: { bridgeId: bridge.id, resourceLoadId: currentResourceLoadId },
			})
		}

		expect(jscore.postMessage.mock.calls.map(([message]) => message.type)).toEqual([
			'resourceLoaded',
			'pageShow',
		])
	})
})
