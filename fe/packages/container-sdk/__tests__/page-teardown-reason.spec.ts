import type { MiniApp } from '../src/pages/miniApp/miniApp.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createContainer } from '../src/index.js'
import { ENTRY_PAGE_PATH } from './fixtures/app-config.js'
import { FakeWorker, resetFakeWorker } from './fixtures/fake-worker.js'
import { installFetchMock } from './fixtures/mock-fetch.js'

// 微信只在页面真的被路由换掉时才卸载页面；关掉整个小程序走的是切后台那条路，只有
// App.onHide。销毁 Bridge 这一步两种情况都要做，区别只在要不要派发 Page.onUnload，
// 所以原因必须由关闭方带下来，不能由销毁点自己猜。Android 见 core/Bridge.kt 的
// PageStateTeardown，iOS 见 DMPPageStateTeardown。

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
	bridge.messageInvoke('service', { type: 'serviceResourceLoaded', target: 'service', body })
	bridge.messageInvoke('render', { type: 'renderResourceLoaded', target: 'service', body })
}

describe('page teardown reason decides whether Page.onUnload is dispatched', () => {
	let mount: HTMLElement

	beforeEach(() => {
		installFetchMock()
		resetFakeWorker()
		mount = document.createElement('div')
		document.body.appendChild(mount)
	})

	it('dispatches pageUnload when a route replaces the page', async () => {
		const container = createContainer({ mount })
		const app = await container.openApp({ appId: 'teardown-routing', path: ENTRY_PAGE_PATH })
		await waitForReady(app)
		await markTopBridgeReady(app)
		const worker = app.jscore.worker as unknown as FakeWorker

		app.navigator.top!.destroy()

		expect(messagesOfType(worker, 'pageUnload')).toHaveLength(1)
	}, 15000)

	it('reclaims the page silently when the whole mini program is torn down', async () => {
		const container = createContainer({ mount })
		const app = await container.openApp({ appId: 'teardown-exit', path: ENTRY_PAGE_PATH })
		await waitForReady(app)
		await markTopBridgeReady(app)
		const worker = app.jscore.worker as unknown as FakeWorker

		app.navigator.top!.destroy('exit')

		expect(messagesOfType(worker, 'pageUnload')).toHaveLength(0)
	}, 15000)

	it('reclaims every stack and tab page silently on the exit lifecycle path', async () => {
		const container = createContainer({ mount })
		const app = await container.openApp({ appId: 'teardown-exit-all', path: ENTRY_PAGE_PATH })
		await waitForReady(app)
		await markTopBridgeReady(app)
		const worker = app.jscore.worker as unknown as FakeWorker

		app.queueDestructionLifecycle()

		expect(messagesOfType(worker, 'pageUnload')).toHaveLength(0)
	}, 15000)
})
