import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import build from '../src/index.js'
import { getComponent, getPages, storeInfo } from '../src/env.js'

describe('custom tabBar compilation', () => {
	let tempDir

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-tab-bar-'))
		fs.writeFileSync(path.join(tempDir, 'project.config.json'), JSON.stringify({ appid: 'custom-tab-bar-test' }))
		for (const page of ['home', 'message', 'detail']) {
			const pageDir = path.join(tempDir, 'pages', page)
			fs.mkdirSync(pageDir, { recursive: true })
			fs.writeFileSync(path.join(pageDir, 'index.json'), '{}')
		}
	})

	afterEach(() => {
		vi.restoreAllMocks()
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	it('injects custom-tab-bar/index only into configured tab pages', () => {
		fs.writeFileSync(path.join(tempDir, 'app.json'), JSON.stringify({
			pages: ['pages/home/index', 'pages/message/index', 'pages/detail/index'],
			tabBar: {
				custom: true,
				list: [
					{ pagePath: 'pages/home/index', text: 'Home' },
					{ pagePath: 'pages/message/index', text: 'Messages' },
				],
			},
		}))

		const tabBarDir = path.join(tempDir, 'custom-tab-bar')
		fs.mkdirSync(tabBarDir, { recursive: true })
		fs.writeFileSync(path.join(tabBarDir, 'index.json'), JSON.stringify({ component: true }))

		storeInfo(tempDir)
		const { mainPages } = getPages()
		const home = mainPages.find(page => page.path === 'pages/home/index')
		const message = mainPages.find(page => page.path === 'pages/message/index')
		const detail = mainPages.find(page => page.path === 'pages/detail/index')

		expect(home.customTabBar).toEqual({ componentName: expect.any(String) })
		expect(message.customTabBar).toEqual({ componentName: expect.any(String) })
		expect(home.usingComponents[home.customTabBar.componentName]).toBe('/custom-tab-bar/index')
		expect(message.usingComponents[message.customTabBar.componentName]).toBe('/custom-tab-bar/index')
		expect(detail.customTabBar).toBeUndefined()
		expect(getComponent('/custom-tab-bar/index')).toMatchObject({
			path: '/custom-tab-bar/index',
			component: true,
			customTabBar: true,
		})
	})

	it('does not inject a missing custom tabBar component', () => {
		fs.writeFileSync(path.join(tempDir, 'app.json'), JSON.stringify({
			pages: ['pages/home/index'],
			tabBar: {
				custom: true,
				list: [{ pagePath: 'pages/home/index', text: 'Home' }],
			},
		}))
		vi.spyOn(console, 'warn').mockImplementation(() => {})

		storeInfo(tempDir)
		const { mainPages } = getPages()

		expect(mainPages[0].customTabBar).toBeUndefined()
		expect(console.warn).toHaveBeenCalledWith(
			'[env] tabBar.custom 已启用，但找不到 custom-tab-bar/index.json',
		)
	})

	it('emits the custom tabBar view, logic, and styles with each tab page', async () => {
		const write = (relativePath, content) => {
			const filePath = path.join(tempDir, relativePath)
			fs.mkdirSync(path.dirname(filePath), { recursive: true })
			fs.writeFileSync(filePath, content)
		}
		write('app.json', JSON.stringify({
			pages: ['pages/home/index'],
			tabBar: {
				custom: true,
				list: [{ pagePath: 'pages/home/index', text: 'Home' }],
			},
		}))
		write('app.js', 'App({})')
		write('app.wxss', '')
		write('pages/home/index.json', '{}')
		write('pages/home/index.js', 'Page({})')
		write('pages/home/index.wxml', '<view>page content</view>')
		write('pages/home/index.wxss', '')
		write('custom-tab-bar/index.json', JSON.stringify({ component: true }))
		write('custom-tab-bar/index.js', 'Component({ methods: { switchTab() {} } })')
		write('custom-tab-bar/index.wxml', '<view class="custom-tab-bar" bind:tap="switchTab">ICON</view>')
		write('custom-tab-bar/index.wxss', '.custom-tab-bar { position: fixed; bottom: 0; }')
		const outputDir = path.join(tempDir, 'output')

		await build(outputDir, tempDir, false)

		const appConfig = JSON.parse(fs.readFileSync(path.join(outputDir, 'main/app-config.json'), 'utf8'))
		const viewCode = fs.readFileSync(path.join(outputDir, 'main/pages_home_index.js'), 'utf8')
		const logicCode = fs.readFileSync(path.join(outputDir, 'main/logic.js'), 'utf8')
		const styleCode = fs.readFileSync(path.join(outputDir, 'main/pages_home_index.css'), 'utf8')
		const customTabBar = appConfig.modules['pages/home/index'].customTabBar
		expect(customTabBar).toEqual({ componentName: expect.any(String) })
		expect(appConfig.modules['pages/home/index'].usingComponents[customTabBar.componentName])
			.toBe('/custom-tab-bar/index')
		expect(viewCode).toContain('/custom-tab-bar/index')
		expect(viewCode).toContain('customTabBar')
		expect(viewCode).toContain('ICON')
		expect(logicCode).toContain('/custom-tab-bar/index')
		expect(styleCode).toContain('position:fixed')
	})
})
