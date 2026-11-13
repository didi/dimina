// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getAppList } = vi.hoisted(() => ({ getAppList: vi.fn() }))

vi.mock('@/services', () => ({
	getAppList,
}))

import { AppList } from '../src/pages/appList/appList.js'

describe('app list navigation', () => {
	let page
	let list

	beforeEach(async () => {
		getAppList.mockResolvedValue([{ appId: 'retained-a', name: 'A', path: 'pages/index', logo: '/logo.png' }])
		getAppList.mockClear()
		page = new AppList({ openApp: vi.fn() })
		page.parent = { shell: { updateStatusBarColor: vi.fn() } }
		page.viewDidLoad()
		list = page.el.querySelector('.dimina-app__mini-used-list')
		await vi.waitFor(() => expect(list.children).toHaveLength(1))
	})

	it('opens list entries without requesting destruction of retained apps', async () => {
		list.querySelector('[data-appid="retained-a"]').click()
		await vi.waitFor(() => expect(page.container.openApp).toHaveBeenCalledOnce())
		const options = page.container.openApp.mock.calls[0][0]
		expect(options.appId).toBe('retained-a')
		expect(options.path).toBe('pages/index')
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
		const requests = getAppList.mock.calls.length
		page.el.querySelector('[data-appid="local-app"]').click()
		expect(onOpenGenerated).toHaveBeenCalledWith('local-app')
		expect(getAppList.mock.calls.length).toBe(requests)
		expect(page.container.openApp).not.toHaveBeenCalled()
	})
})
