import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createContainer } from '../src/index.js'
import { resetFakeWorker } from './fixtures/fake-worker.js'
import { installFetchMock } from './fixtures/mock-fetch.js'

// 回归测试：地址栏路由同步必须只有一个权威调用点（Application.syncUrl()，
// 从当前展示栈栈顶实例派生），而不是 MiniApp 导航、closeApp 各自零散调用 urlSync。
//
// 抓的 bug：closeApp() 完全不碰 urlSync——关掉栈顶小程序后地址栏仍停在被关闭
// 的小程序上；宿主刷新页面按地址栏 QueryRouter.parse() 自动 openApp() 恢复
// （见 fe/packages/container/src/index.js），于是又把刚被用户关掉的小程序打开了。

describe('Application.syncUrl() keeps the address bar in sync with the actual top of the view stack', () => {
	let mount: HTMLElement

	beforeEach(() => {
		installFetchMock()
		resetFakeWorker()
		mount = document.createElement('div')
		document.body.appendChild(mount)
	})

	it('closing the top instance re-syncs the URL to the instance revealed underneath it', async () => {
		const container = createContainer({ mount })

		await container.openApp({ appId: 'wx-url-authority-a', path: 'pages/index/index' })
		await container.openApp({ appId: 'wx-url-authority-b', path: 'pages/index/index' })

		await vi.waitFor(() => {
			expect(new URLSearchParams(window.location.search).get('appId')).toBe('wx-url-authority-b')
		}, { timeout: 8000 })

		container.closeApp() // 不传参数：关闭栈顶（B）

		await vi.waitFor(() => {
			expect(new URLSearchParams(window.location.search).get('appId')).toBe('wx-url-authority-a')
		}, { timeout: 8000 })
	}, 10000)

	it('closing the only open instance clears the URL instead of leaving it stale', async () => {
		const container = createContainer({ mount })

		await container.openApp({ appId: 'wx-url-authority-solo', path: 'pages/index/index' })

		await vi.waitFor(() => {
			expect(new URLSearchParams(window.location.search).get('appId')).toBe('wx-url-authority-solo')
		}, { timeout: 8000 })

		container.closeApp()

		await vi.waitFor(() => {
			expect(new URLSearchParams(window.location.search).get('appId')).toBeNull()
		}, { timeout: 8000 })
	}, 10000)
})
