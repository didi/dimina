import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createContainer } from '../src/index.js'
import { installFetchMock } from './fixtures/mock-fetch.js'

// 契约行为 4/5：shell 适配器缺省安全（0 高度状态栏，不抛错），
// 传入 shell.getStatusBarRect / shell.updateStatusBarColor 时要被实际使用，
// 而不是去查 DOM 里的 .iphone__status-bar（现状 container 的做法）。
//
// 用 getSystemInfoSync().statusBarHeight 作为可观测锚点：现状实现里
// statusBarHeight 直接来自状态栏矩形的 height，缺省兜底是 `|| 20`；
// 契约要求 SDK 缺省是 0，这是本文件要抓的关键回归点。
describe('shell status bar adapter', () => {
	let mount: HTMLElement

	beforeEach(() => {
		installFetchMock()
		mount = document.createElement('div')
		document.body.appendChild(mount)
	})

	it('defaults to a zero-height status bar without throwing when shell is not provided', async () => {
		const container = createContainer({ mount })
		const miniApp = await container.openApp({ appId: 'wx-shell-default', path: 'pages/index/index' })

		expect(() => miniApp.getSystemInfoSync()).not.toThrow()
		expect(miniApp.getSystemInfoSync().statusBarHeight).toBe(0)
	}, 10000)

	it('uses the injected getStatusBarRect instead of querying DOM shell markup', async () => {
		const getStatusBarRect = vi.fn(() => ({ top: 0, left: 0, width: 375, height: 44, right: 375, bottom: 44 }))
		const container = createContainer({ mount, shell: { getStatusBarRect } })
		const miniApp = await container.openApp({ appId: 'wx-shell-injected', path: 'pages/index/index' })

		const systemInfo = miniApp.getSystemInfoSync()

		expect(getStatusBarRect).toHaveBeenCalled()
		expect(systemInfo.statusBarHeight).toBe(44)
	}, 10000)

	it('does not throw during app boot when shell.updateStatusBarColor is not provided', async () => {
		const container = createContainer({ mount })

		await expect(
			container.openApp({ appId: 'wx-shell-color-default', path: 'pages/index/index' }),
		).resolves.toBeTruthy()

		// 给后台的颜色计算链路一点时间跑完，确认没有产生 unhandled rejection。
		await new Promise(resolve => setTimeout(resolve, 50))
	}, 10000)

	it('notifies the injected updateStatusBarColor as the entry page color is resolved', async () => {
		const updateStatusBarColor = vi.fn()
		const container = createContainer({ mount, shell: { updateStatusBarColor } })

		await container.openApp({ appId: 'wx-shell-color', path: 'pages/index/index' })

		await vi.waitFor(() => {
			expect(updateStatusBarColor).toHaveBeenCalled()
		}, { timeout: 8000 })
	}, 10000)
})
