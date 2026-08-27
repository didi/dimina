import type { MiniApp } from '../src/pages/miniApp/miniApp.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createContainer } from '../src/index.js'
import { ENTRY_PAGE_PATH } from './fixtures/app-config.js'
import { FakeWorker, resetFakeWorker } from './fixtures/fake-worker.js'
import { installFetchMock } from './fixtures/mock-fetch.js'

function messagesOfType(worker: FakeWorker, type: string): Array<Record<string, unknown>> {
	return worker.postMessage.mock.calls
		.map(([message]: [Record<string, unknown>]) => message)
		.filter(message => message.type === type)
}

async function waitForReady(app: MiniApp): Promise<void> {
	await vi.waitFor(() => expect(app.appConfig).not.toBeNull(), { timeout: 8000 })
}

async function markTopBridgeReady(app: MiniApp): Promise<void> {
	await vi.waitFor(() => expect(app.navigator.top?.resourceLoadId).toEqual(expect.any(String)), { timeout: 8000 })
	const bridge = app.navigator.top!
	const body = {
		bridgeId: bridge.id,
		resourceLoadId: bridge.resourceLoadId!,
	}
	bridge.messageInvoke('service', {
		type: 'serviceResourceLoaded',
		target: 'service',
		body,
	})
	bridge.messageInvoke('render', {
		type: 'renderResourceLoaded',
		target: 'service',
		body,
	})
}

async function markTopBridgeServiceReady(app: MiniApp): Promise<void> {
	await vi.waitFor(() => expect(app.navigator.top?.resourceLoadId).toEqual(expect.any(String)), { timeout: 8000 })
	const bridge = app.navigator.top!
	bridge.messageInvoke('service', {
		type: 'serviceResourceLoaded',
		target: 'service',
		body: {
			bridgeId: bridge.id,
			resourceLoadId: bridge.resourceLoadId!,
		},
	})
}

describe('mini program container navigation APIs', () => {
	let mount: HTMLElement

	beforeEach(() => {
		installFetchMock()
		resetFakeWorker()
		mount = document.createElement('div')
		document.body.appendChild(mount)
	})

	it('navigateToMiniProgram opens the target entry with scene 1037 and referrerInfo when path is omitted', async () => {
		const container = createContainer({ mount })
		const source = await container.openApp({ appId: 'source-app', path: ENTRY_PAGE_PATH })
		await waitForReady(source)
		await markTopBridgeReady(source)
		source.jscore.notifyServiceReady()
		const sourceWorker = source.jscore.worker as unknown as FakeWorker

		await source.navigateToMiniProgram({
			appId: 'target-app',
			extraData: { token: 'open' },
			success: 'open-success',
			complete: 'open-complete',
		})

		const target = container.application.appManager.getAppById('target-app')!
		await waitForReady(target)
		const targetWorker = target.jscore.worker as unknown as FakeWorker
		const [loadResource] = messagesOfType(targetWorker, 'loadResource')

		expect(container.application.views).toEqual([source, target])
		// Issue #44: source 只进入后台，不能因为另一个小程序被呈现就销毁运行时。
		expect(container.application.appManager.getAppById('source-app')).toBe(source)
		expect(source.jscore.worker).toBe(sourceWorker)
		expect(sourceWorker.terminate).not.toHaveBeenCalled()
		expect(messagesOfType(sourceWorker, 'appHide')).toHaveLength(1)
		const sourceHideTypes = sourceWorker.postMessage.mock.calls
			.map(([message]) => message.type)
			.filter(type => type === 'pageHide' || type === 'appHide')
		expect(sourceHideTypes).toEqual(['pageHide', 'appHide'])
		expect(target.opener).toBe(source)
		expect(loadResource.body).toMatchObject({
			pagePath: ENTRY_PAGE_PATH,
			scene: 1037,
			referrerInfo: {
				appId: 'source-app',
				extraData: { token: 'open' },
			},
		})
		expect(messagesOfType(sourceWorker, 'triggerCallback').map(message => message.body)).toEqual([
			{ id: 'open-success', args: { errMsg: 'navigateToMiniProgram:ok' } },
			{ id: 'open-complete', args: { errMsg: 'navigateToMiniProgram:ok' } },
		])
	}, 15000)

	it('does not emit a late pageHide after appHide when the source render is still loading', async () => {
		const container = createContainer({ mount })
		const source = await container.openApp({ appId: 'pending-source', path: ENTRY_PAGE_PATH })
		await waitForReady(source)
		await markTopBridgeServiceReady(source)
		const sourceBridge = source.navigator.top!
		const sourceWorker = source.jscore.worker as unknown as FakeWorker

		await source.navigateToMiniProgram({ appId: 'pending-target' })
		sourceBridge.messageInvoke('render', {
			type: 'renderResourceLoaded',
			target: 'service',
			body: {
				bridgeId: sourceBridge.id,
				resourceLoadId: sourceBridge.resourceLoadId!,
			},
		})

		const visibilityTypes = sourceWorker.postMessage.mock.calls
			.map(([message]) => message.type)
			.filter(type => type === 'pageShow' || type === 'pageHide' || type === 'appHide')
		expect(visibilityTypes).toEqual(['appHide'])
		expect(sourceBridge.sentPageVisible).toBe(false)
	}, 15000)

	it('navigateBackMiniProgram destroys the target and resumes its opener with scene 1038 return data', async () => {
		const container = createContainer({ mount })
		const source = await container.openApp({ appId: 'back-source', path: ENTRY_PAGE_PATH })
		await waitForReady(source)
		source.jscore.notifyServiceReady()
		await source.navigateToMiniProgram({ appId: 'back-target' })
		const target = container.application.appManager.getAppById('back-target')!
		await waitForReady(target)
		await markTopBridgeReady(target)
		const targetWorker = target.jscore.worker as unknown as FakeWorker
		const sourceWorker = source.jscore.worker as unknown as FakeWorker

		await target.navigateBackMiniProgram({
			extraData: { token: 'back' },
			success: 'back-success',
			complete: 'back-complete',
		})

		expect(container.application.views).toEqual([source])
		expect(container.application.appManager.getAppById('back-source')).toBe(source)
		expect(source.jscore.worker).toBe(sourceWorker)
		expect(sourceWorker.terminate).not.toHaveBeenCalled()
		expect(container.application.appManager.getAppById('back-target')).toBeNull()
		expect(targetWorker.terminate).toHaveBeenCalledTimes(1)
		expect(messagesOfType(sourceWorker, 'appShow').at(-1)?.body).toEqual({
			scene: 1038,
			path: ENTRY_PAGE_PATH,
			query: {},
			referrerInfo: {
				appId: 'back-target',
				extraData: { token: 'back' },
			},
		})
		expect(messagesOfType(targetWorker, 'triggerCallback').map(message => message.body)).toEqual([
			{ id: 'back-success', args: { errMsg: 'navigateBackMiniProgram:ok' } },
			{ id: 'back-complete', args: { errMsg: 'navigateBackMiniProgram:ok' } },
		])
		expect(messagesOfType(targetWorker, 'flushCallbacks')).toHaveLength(1)
		// 退出不是路由：页面静默回收，只有 App.onHide，不发 Page.onUnload。
		expect(messagesOfType(targetWorker, 'pageUnload')).toHaveLength(0)
		const targetMessageTypes = targetWorker.postMessage.mock.calls.map(([message]) => message.type)
		expect(targetMessageTypes.indexOf('triggerCallback')).toBeLessThan(targetMessageTypes.indexOf('flushCallbacks'))
	}, 20000)

	it('exitMiniProgram runs callbacks before terminating and removes the current runtime', async () => {
		const container = createContainer({ mount })
		const app = await container.openApp({ appId: 'exit-app', path: ENTRY_PAGE_PATH })
		await waitForReady(app)
		await markTopBridgeReady(app)
		const worker = app.jscore.worker as unknown as FakeWorker

		await app.exitMiniProgram({ success: 'exit-success', complete: 'exit-complete' })

		expect(container.application.views).toEqual([])
		expect(container.application.appManager.getAppById('exit-app')).toBeNull()
		expect(messagesOfType(worker, 'triggerCallback').map(message => message.body)).toEqual([
			{ id: 'exit-success', args: { errMsg: 'exitMiniProgram:ok' } },
			{ id: 'exit-complete', args: { errMsg: 'exitMiniProgram:ok' } },
		])
		expect(messagesOfType(worker, 'flushCallbacks')).toHaveLength(1)
		// 退出不是路由：页面静默回收，只有 App.onHide，不发 Page.onUnload。
		expect(messagesOfType(worker, 'pageUnload')).toHaveLength(0)
		const messageTypes = worker.postMessage.mock.calls.map(([message]) => message.type)
		expect(messageTypes.indexOf('triggerCallback')).toBeLessThan(messageTypes.indexOf('flushCallbacks'))
		expect(worker.terminate).toHaveBeenCalledTimes(1)
	}, 15000)

	it('exitMiniProgram resumes a real opener with scene 1038 even though it has no return extraData', async () => {
		const container = createContainer({ mount })
		const source = await container.openApp({ appId: 'exit-source', path: ENTRY_PAGE_PATH })
		await waitForReady(source)
		source.jscore.notifyServiceReady()
		await source.navigateToMiniProgram({ appId: 'exit-target' })
		const target = container.application.appManager.getAppById('exit-target')!
		await waitForReady(target)
		const sourceWorker = source.jscore.worker as unknown as FakeWorker

		await target.exitMiniProgram()

		expect(container.application.views).toEqual([source])
		expect(messagesOfType(sourceWorker, 'appShow').at(-1)?.body).toEqual({
			scene: 1038,
			path: ENTRY_PAGE_PATH,
			query: {},
			referrerInfo: { appId: 'exit-target' },
		})
	}, 20000)

	it('restartMiniProgram atomically replaces the active MiniApp and rebuilds its worker at the requested path', async () => {
		const container = createContainer({ mount })
		const original = await container.openApp({ appId: 'restart-app', path: ENTRY_PAGE_PATH })
		await waitForReady(original)
		await markTopBridgeReady(original)
		const originalWorker = original.jscore.worker as unknown as FakeWorker

		const restartPromise = original.restartMiniProgram({
			path: `${ENTRY_PAGE_PATH}?from=restart`,
			success: 'restart-success',
			complete: 'restart-complete',
		})
		await vi.waitFor(() => {
			const candidate = container.application.appManager.getAppById('restart-app')
			expect(candidate).not.toBe(original)
			expect(candidate?.navigator.top?.resourceLoadId).toEqual(expect.any(String))
		}, { timeout: 8000 })
		const startingReplacement = container.application.appManager.getAppById('restart-app')!
		const startingBridge = startingReplacement.navigator.top!
		const readyBody = {
			bridgeId: startingBridge.id,
			resourceLoadId: startingBridge.resourceLoadId!,
		}
		startingBridge.messageInvoke('service', {
			type: 'serviceResourceLoaded',
			target: 'service',
			body: readyBody,
		})
		startingBridge.messageInvoke('render', {
			type: 'renderResourceLoaded',
			target: 'service',
			body: readyBody,
		})
		await restartPromise

		const replacement = container.application.appManager.getAppById('restart-app')!
		expect(replacement).not.toBe(original)
		expect(container.application.views).toEqual([replacement])
		expect(replacement.pagePath).toBe(ENTRY_PAGE_PATH)
		expect(replacement.query).toEqual({ from: 'restart' })
		expect(replacement.jscore.worker).not.toBe(originalWorker)
		expect(messagesOfType(originalWorker, 'triggerCallback').map(message => message.body)).toEqual([
			{ id: 'restart-success', args: { errMsg: 'restartMiniProgram:ok' } },
			{ id: 'restart-complete', args: { errMsg: 'restartMiniProgram:ok' } },
		])
		expect(messagesOfType(originalWorker, 'flushCallbacks')).toHaveLength(1)
		// 冷重启整体换 runtime，同样不是路由：旧页面静默回收，不发 Page.onUnload。
		expect(messagesOfType(originalWorker, 'pageUnload')).toHaveLength(0)
		const originalMessageTypes = originalWorker.postMessage.mock.calls.map(([message]) => message.type)
		expect(originalMessageTypes.indexOf('triggerCallback')).toBeLessThan(originalMessageTypes.indexOf('flushCallbacks'))
		expect(originalWorker.terminate).toHaveBeenCalledTimes(1)
	}, 15000)

	it('rolls back restart when the requested page is not declared', async () => {
		const container = createContainer({ mount })
		const original = await container.openApp({ appId: 'restart-missing-page-app', path: ENTRY_PAGE_PATH })
		await waitForReady(original)
		const originalWorker = original.jscore.worker as unknown as FakeWorker
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

		try {
			await original.restartMiniProgram({
				path: 'pages/missing/index',
				fail: 'missing-page-fail',
				complete: 'missing-page-complete',
			})
		}
		finally {
			consoleError.mockRestore()
		}

		expect(container.application.views).toEqual([original])
		expect(container.application.appManager.getAppById('restart-missing-page-app')).toBe(original)
		expect(originalWorker.terminate).not.toHaveBeenCalled()
		expect(messagesOfType(originalWorker, 'triggerCallback').map(message => (message.body as { id: string }).id)).toEqual([
			'missing-page-fail',
			'missing-page-complete',
		])
	}, 15000)

	it('rolls back restart when the replacement worker fails during resource bootstrap', async () => {
		const container = createContainer({ mount })
		const original = await container.openApp({ appId: 'restart-worker-app', path: ENTRY_PAGE_PATH })
		await waitForReady(original)
		const originalWorker = original.jscore.worker as unknown as FakeWorker
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

		try {
			const restartPromise = original.restartMiniProgram({
				path: ENTRY_PAGE_PATH,
				fail: 'worker-restart-fail',
				complete: 'worker-restart-complete',
			})
			await vi.waitFor(() => {
				const candidate = container.application.appManager.getAppById('restart-worker-app')
				expect(candidate).not.toBe(original)
				expect(candidate?.navigator.top?.resourceLoadId).toEqual(expect.any(String))
			}, { timeout: 8000 })
			const replacement = container.application.appManager.getAppById('restart-worker-app')!
			const replacementWorker = replacement.jscore.worker as unknown as FakeWorker
			;(replacementWorker.onerror as ((event: Event) => void) | null)?.(new Event('error'))
			await restartPromise
		}
		finally {
			consoleError.mockRestore()
		}

		expect(container.application.views).toEqual([original])
		expect(container.application.appManager.getAppById('restart-worker-app')).toBe(original)
		expect(originalWorker.terminate).not.toHaveBeenCalled()
		expect(messagesOfType(originalWorker, 'triggerCallback').map(message => (message.body as { id: string }).id)).toEqual([
			'worker-restart-fail',
			'worker-restart-complete',
		])
	}, 15000)

	it('rolls back to the original runtime when the replacement cannot initialize', async () => {
		const container = createContainer({ mount })
		const original = await container.openApp({ appId: 'restart-rollback-app', path: ENTRY_PAGE_PATH })
		await waitForReady(original)
		const originalWorker = original.jscore.worker as unknown as FakeWorker
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
		globalThis.fetch = vi.fn().mockRejectedValue(new Error('replacement config unavailable')) as typeof fetch

		try {
			await original.restartMiniProgram({
				path: `${ENTRY_PAGE_PATH}?from=failed-restart`,
				fail: 'restart-fail',
				complete: 'restart-complete',
			})
		}
		finally {
			consoleError.mockRestore()
		}

		expect(container.application.views).toEqual([original])
		expect(container.application.appManager.getAppById('restart-rollback-app')).toBe(original)
		expect(originalWorker.terminate).not.toHaveBeenCalled()
		expect(messagesOfType(originalWorker, 'triggerCallback').map(message => message.body)).toEqual([
			{ id: 'restart-fail', args: { errMsg: expect.stringContaining('restartMiniProgram:fail') } },
			{ id: 'restart-complete', args: { errMsg: expect.stringContaining('restartMiniProgram:fail') } },
		])
	}, 15000)

	it('releases a destructive operation when the worker fails before the callback barrier ack', async () => {
		const container = createContainer({ mount })
		const app = await container.openApp({ appId: 'worker-failure-app', path: ENTRY_PAGE_PATH })
		await waitForReady(app)
		const worker = app.jscore.worker as unknown as FakeWorker
		worker.postMessage.mockImplementation(() => {})

		const exitPromise = app.exitMiniProgram({ success: 'exit-success', complete: 'exit-complete' })
		await vi.waitFor(() => expect(messagesOfType(worker, 'flushCallbacks')).toHaveLength(1))
		;(worker.onerror as ((event: Event) => void) | null)?.(new Event('error'))
		await exitPromise

		expect(container.application.views).toEqual([])
		expect(worker.terminate).toHaveBeenCalledTimes(1)
	}, 15000)

	it('rejects malformed dynamic parameters before mutating the presentation stack', async () => {
		const container = createContainer({ mount })
		const app = await container.openApp({ appId: 'invalid-params-app', path: ENTRY_PAGE_PATH })
		await waitForReady(app)
		const worker = app.jscore.worker as unknown as FakeWorker

		await app.navigateToMiniProgram({ appId: 'target', extraData: null, fail: 'extra-fail' } as never)
		await app.navigateToMiniProgram({ appId: 'target', envVersion: false, fail: 'env-fail' } as never)
		await app.navigateToMiniProgram({ appId: 'target', noRelaunchIfPathUnchanged: 'false', fail: 'flag-fail' } as never)
		await app.navigateToMiniProgram({ appId: 'target', path: 42, fail: 'path-fail' } as never)
		await app.navigateBackMiniProgram({ extraData: [], fail: 'back-extra-fail' } as never)

		expect(container.application.views).toEqual([app])
		expect(messagesOfType(worker, 'triggerCallback').map(message => (message.body as { id: string }).id)).toEqual([
			'extra-fail',
			'env-fail',
			'flag-fail',
			'path-fail',
			'back-extra-fail',
		])
	}, 15000)

	it('fails navigateBack without an opener and restart without a path without destroying the runtime', async () => {
		const container = createContainer({ mount })
		const app = await container.openApp({ appId: 'invalid-app', path: ENTRY_PAGE_PATH })
		await waitForReady(app)
		const worker = app.jscore.worker as unknown as FakeWorker

		await app.navigateBackMiniProgram({ fail: 'back-fail', complete: 'back-complete' })
		await app.restartMiniProgram({ fail: 'restart-fail', complete: 'restart-complete' })

		expect(container.application.views).toEqual([app])
		expect(worker.terminate).not.toHaveBeenCalled()
		expect(messagesOfType(worker, 'triggerCallback').map(message => (message.body as { id: string }).id)).toEqual([
			'back-fail',
			'back-complete',
			'restart-fail',
			'restart-complete',
		])
	}, 15000)
})
