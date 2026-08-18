import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createContainer } from '../src/index.js'
import { resetFakeWorker } from './fixtures/fake-worker.js'
import { installFetchMock } from './fixtures/mock-fetch.js'

// 回归测试："..." 菜单里的「复制链接」快捷操作此前绕开 urlSync 适配器，
// 直接调用内置 QueryRouter.buildRouteURL 拼地址——自定义 urlSync 适配器接管
// 地址栏同步后，「复制链接」复制出来的仍是内置 QueryRouter 语义的地址，
// 与宿主实际路由（如 hash-router）完全对不上；urlSync: false 关闭同步后，
// 复制的链接更是指向一个宿主从未同步过、根本打不开的地址。
//
// 修复：UrlSyncAdapter 新增可选方法 buildShareUrl?: (appId, stack) => string。
// 「复制链接」必须经由容器当前生效的 urlSync 适配器构建：适配器没有实现
// buildShareUrl（值为 undefined）或调用返回 falsy 值时，「复制链接」这一项
// 整体不出现在快捷操作列表里（不是禁用态，是不渲染），其余快捷操作
// （重新进入 / 关闭小程序）必须始终在场，不受影响。

const COPY_LINK_LABEL = '复制链接'

function stubClipboard(): { writeText: ReturnType<typeof vi.fn> } {
	const writeText = vi.fn().mockResolvedValue(undefined)
	Object.defineProperty(navigator, 'clipboard', {
		value: { writeText },
		configurable: true,
	})
	return { writeText }
}

function findQuickActionButtons(root: HTMLElement): HTMLButtonElement[] {
	return Array.from(root.querySelectorAll<HTMLButtonElement>('.dimina-mini-app-menu__quick-action'))
}

function findQuickActionByLabel(root: HTMLElement, label: string): HTMLButtonElement | undefined {
	return findQuickActionButtons(root).find((btn) => {
		const labelEl = btn.querySelector<HTMLElement>('.dimina-mini-app-menu__quick-action-label')
		return labelEl?.textContent === label
	})
}

describe('the "复制链接" quick action is built from the urlSync adapter\'s buildShareUrl', () => {
	let mount: HTMLElement

	beforeEach(() => {
		installFetchMock()
		resetFakeWorker()
		mount = document.createElement('div')
		document.body.appendChild(mount)
	})

	it('default urlSync:true built-in adapter implements buildShareUrl: "复制链接" is present and copies a URL containing the appId', async () => {
		const { writeText } = stubClipboard()
		const container = createContainer({ mount })

		const miniApp = await container.openApp({ appId: 'wx-menu-copy-default', path: 'pages/index/index' })
		miniApp.openMiniAppMenu()

		const copyLinkBtn = findQuickActionByLabel(miniApp.el, COPY_LINK_LABEL)
		expect(copyLinkBtn).toBeDefined()

		// 三项(复制链接/重新进入/关闭小程序)都在场：DOM 节点数须跟渲染的
		// 快捷操作数一致，回归 grid-template-columns 固定 3 列时空着第三格的问题
		// (见 renderMiniAppMenu() 里对 quickActions.style.gridTemplateColumns 的设置)。
		expect(findQuickActionButtons(miniApp.el)).toHaveLength(3)

		copyLinkBtn!.click()

		await vi.waitFor(() => {
			expect(writeText).toHaveBeenCalled()
		}, { timeout: 8000 })
		expect(writeText.mock.calls[0][0]).toContain('wx-menu-copy-default')
	}, 10000)

	it('urlSync:false: the adapter has no buildShareUrl, so "复制链接" is absent from the quick actions', async () => {
		stubClipboard()
		const container = createContainer({ mount, urlSync: false })

		const miniApp = await container.openApp({ appId: 'wx-menu-copy-disabled', path: 'pages/index/index' })
		miniApp.openMiniAppMenu()

		expect(findQuickActionByLabel(miniApp.el, COPY_LINK_LABEL)).toBeUndefined()

		// 其它快捷操作必须仍在场，不受影响；只剩两项时 DOM 节点数须跟着降到 2
		// (回归 grid-template-columns 固定 3 列时空着第三格的问题)。
		const labels = findQuickActionButtons(miniApp.el).map(
			btn => btn.querySelector('.dimina-mini-app-menu__quick-action-label')?.textContent,
		)
		expect(labels).toContain('重新进入')
		expect(labels).toContain('关闭小程序')
		expect(findQuickActionButtons(miniApp.el)).toHaveLength(2)
	}, 10000)

	it('custom adapter with only { syncStack, clear } (no buildShareUrl field): "复制链接" is absent', async () => {
		stubClipboard()
		const syncStack = vi.fn()
		const clear = vi.fn()
		const container = createContainer({ mount, urlSync: { syncStack, clear } })

		const miniApp = await container.openApp({ appId: 'wx-menu-copy-no-share-fn', path: 'pages/index/index' })
		miniApp.openMiniAppMenu()

		expect(findQuickActionByLabel(miniApp.el, COPY_LINK_LABEL)).toBeUndefined()
	}, 10000)

	it('custom adapter whose buildShareUrl returns a falsy value: "复制链接" is absent', async () => {
		stubClipboard()
		const syncStack = vi.fn()
		const clear = vi.fn()
		const buildShareUrl = vi.fn().mockReturnValue('')
		const container = createContainer({ mount, urlSync: { syncStack, clear, buildShareUrl } })

		const miniApp = await container.openApp({ appId: 'wx-menu-copy-falsy-share', path: 'pages/index/index' })
		miniApp.openMiniAppMenu()

		expect(findQuickActionByLabel(miniApp.el, COPY_LINK_LABEL)).toBeUndefined()
	}, 10000)

	it('custom adapter with buildShareUrl: "复制链接" is present, clicking calls buildShareUrl(appId, stack), and copies exactly its return value', async () => {
		const { writeText } = stubClipboard()
		const syncStack = vi.fn()
		const clear = vi.fn()
		const buildShareUrl = vi.fn().mockReturnValue('https://example.com/custom-share-link')
		const container = createContainer({ mount, urlSync: { syncStack, clear, buildShareUrl } })

		const miniApp = await container.openApp({ appId: 'wx-menu-copy-custom', path: 'pages/index/index' })
		miniApp.openMiniAppMenu()

		const copyLinkBtn = findQuickActionByLabel(miniApp.el, COPY_LINK_LABEL)
		expect(copyLinkBtn).toBeDefined()

		copyLinkBtn!.click()

		await vi.waitFor(() => {
			expect(writeText).toHaveBeenCalled()
		}, { timeout: 8000 })

		expect(buildShareUrl).toHaveBeenCalledWith('wx-menu-copy-custom', expect.any(Array))
		expect(writeText).toHaveBeenCalledWith('https://example.com/custom-share-link')
	}, 10000)

	// 回归测试：renderMiniAppMenu() 目前手工拼出一个二元素数组
	// [{pagePath: getEntryPagePath(), query: this.appInfo.query}, {pagePath: currentPagePath, query: currentPageQuery}]
	// 传给 buildShareUrl，而不是把导航器当前真实持有的页面栈（getPageStack()）原样
	// 传下去。getEntryPagePath()/this.appInfo.query 是 open 时刻定死的快照，
	// reLaunch() 之后 navigator 换成了全新 bridge（哪怕路径字符串相同），
	// getPageStack() 会如实反映新 bridge 的 query，而 this.appInfo 不会更新——
	// 于是手工拼出来的数组第一个元素带着 reLaunch 之前的陈旧 query，长度也和
	// 真实单页栈（长度 1）对不上（手工拼的是长度 2）。
	it('after reLaunch() to a fresh bridge, buildShareUrl is called with the navigator\'s real current page stack, not a stale entry-page snapshot', async () => {
		stubClipboard()
		const syncStack = vi.fn()
		const clear = vi.fn()
		const buildShareUrl = vi.fn().mockReturnValue('https://example.com/relaunch-share-link')
		const container = createContainer({ mount, urlSync: { syncStack, clear, buildShareUrl } })

		const miniApp = await container.openApp({ appId: 'wx-menu-copy-relaunch', path: 'pages/index/index' })

		const bridgeBeforeRelaunch = miniApp.navigator.top

		// 单页 fixture（app-config.js 只声明了 pages/index/index）也足以复现：
		// bug 的根子不在路径字符串是否不同，而在 renderMiniAppMenu() 用的是哪个
		// 派生函数——reLaunch() 到带 query 的同一路径，会销毁旧 bridge、换上一个
		// query 不同的新 bridge，getEntryPagePath()/this.appInfo.query 却原地不动。
		miniApp.reLaunch({ url: '/pages/index/index?foo=bar' })

		// reLaunch 是回调式而非 Promise：轮询 navigator.top 换成新 bridge 对象，
		// 确认 destroy 旧 bridge / createBridge 新 bridge / pushPage 挂载整套流程已落定。
		await vi.waitFor(() => {
			expect(miniApp.navigator.top).not.toBe(bridgeBeforeRelaunch)
		}, { timeout: 8000 })

		const realCurrentStack = miniApp.getPageStack()

		miniApp.openMiniAppMenu()

		const copyLinkBtn = findQuickActionByLabel(miniApp.el, COPY_LINK_LABEL)
		expect(copyLinkBtn).toBeDefined()

		copyLinkBtn!.click()

		await vi.waitFor(() => {
			expect(buildShareUrl).toHaveBeenCalled()
		}, { timeout: 8000 })

		expect(buildShareUrl.mock.calls[0][0]).toBe('wx-menu-copy-relaunch')
		expect(buildShareUrl.mock.calls[0][1]).toEqual(realCurrentStack)
	}, 10000)
})
