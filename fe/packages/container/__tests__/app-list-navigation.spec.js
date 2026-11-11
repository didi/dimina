// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getAppList, getMiniAppInfo } = vi.hoisted(() => ({
	getAppList: vi.fn(() => new Promise(() => {})),
	getMiniAppInfo: vi.fn(),
}))

vi.mock('@/services', () => ({
	getAppList,
	getMiniAppInfo,
}))

import { AppList } from '../src/pages/appList/appList.js'

describe('app list navigation', () => {
	let page
	let list

	beforeEach(() => {
		getAppList.mockClear()
		getMiniAppInfo.mockReset()
		page = new AppList({ openApp: vi.fn() })
		page.parent = { shell: { updateStatusBarColor: vi.fn() } }
		page.viewDidLoad()
		list = page.el.querySelector('.dimina-app__mini-used-list')
	})

	it('opens list entries without requesting destruction of retained apps', async () => {
		page.renderAppList([{ appId: 'retained-a', name: 'A' }])
		getMiniAppInfo.mockResolvedValue({ path: 'pages/index' })
		list.querySelector('[data-appid="retained-a"]').click()
		await vi.waitFor(() => expect(page.container.openApp).toHaveBeenCalledOnce())
		const options = page.container.openApp.mock.calls[0][0]
		expect(options.appId).toBe('retained-a')
		expect(options.destroy).not.toBe(true)
	})

	it('restores the status bar color when the list page is presented again', () => {
		page.onPresentIn()

		expect(page.parent.shell.updateStatusBarColor).toHaveBeenCalledWith('black')
	})

	it('opens the integrated workspace and local generated apps without fetching deployed app metadata', () => {
		const onCreate = vi.fn()
		const onOpenGenerated = vi.fn()
		page = new AppList({ openApp: vi.fn() }, { onCreate, onOpenGenerated })
		page.viewDidLoad()
		page.el.querySelector('.dimina-app__generator-link').click()
		expect(onCreate).toHaveBeenCalledOnce()
		page.setGeneratedProjects([{ id: 'local-app', name: '我的打卡本' }])
		page.el.querySelector('[data-appid="local-app"]').click()
		expect(onOpenGenerated).toHaveBeenCalledWith('local-app')
		expect(getMiniAppInfo).not.toHaveBeenCalled()
		expect(page.container.openApp).not.toHaveBeenCalled()
	})
})
