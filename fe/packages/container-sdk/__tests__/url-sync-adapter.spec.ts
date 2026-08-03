import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createContainer } from '../src/index.js'
import { resetFakeWorker } from './fixtures/fake-worker.js'
import { installFetchMock } from './fixtures/mock-fetch.js'

// 回归测试：地址栏路由同步（原 QueryRouter.syncStack/clear）此前无条件调用
// history.replaceState，会删除/覆盖宿主自己的 URL（如宿主 hash-router 的 hash、
// 多容器场景下互相覆盖对方的路由），且没有任何关闭方式。
//
// 修复：urlSync 缺省仍走内置 QueryRouter（向后兼容），但可传 false 完全关闭，
// 也可传自定义适配器接管——两种情况下 SDK 都不能再自己碰 history.replaceState。

describe('urlSync controls whether/how the container touches the address bar', () => {
	let mount: HTMLElement
	let replaceStateSpy: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		installFetchMock()
		resetFakeWorker()
		mount = document.createElement('div')
		document.body.appendChild(mount)
		replaceStateSpy = vi.spyOn(window.history, 'replaceState')
	})

	it('defaults to the built-in QueryRouter and calls history.replaceState (backward compatible)', async () => {
		const container = createContainer({ mount })

		await container.openApp({ appId: 'wx-url-sync-default', path: 'pages/index/index' })

		await vi.waitFor(() => {
			expect(replaceStateSpy).toHaveBeenCalled()
		}, { timeout: 8000 })
	}, 10000)

	it('urlSync: false never touches history.replaceState on open or close', async () => {
		const container = createContainer({ mount, urlSync: false })

		const miniApp = await container.openApp({ appId: 'wx-url-sync-disabled', path: 'pages/index/index' })
		miniApp.closeMiniProgram()

		// 没有异步信号可等待"确实不会发生"，用短暂的 waitFor 失败兜底加常规等待。
		await new Promise(resolve => setTimeout(resolve, 50))
		expect(replaceStateSpy).not.toHaveBeenCalled()
	}, 10000)

	it('a custom urlSync adapter receives syncStack/clear instead of the SDK touching history directly', async () => {
		const syncStack = vi.fn()
		const clear = vi.fn()
		const container = createContainer({ mount, urlSync: { syncStack, clear } })

		const miniApp = await container.openApp({ appId: 'wx-url-sync-custom', path: 'pages/index/index' })

		await vi.waitFor(() => {
			expect(syncStack).toHaveBeenCalledWith('wx-url-sync-custom', expect.any(Array))
		}, { timeout: 8000 })
		expect(replaceStateSpy).not.toHaveBeenCalled()

		miniApp.closeMiniProgram()

		await vi.waitFor(() => {
			expect(clear).toHaveBeenCalled()
		}, { timeout: 8000 })
		expect(replaceStateSpy).not.toHaveBeenCalled()
	}, 10000)
})
