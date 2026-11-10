import type { Bridge } from '../src/core/bridge.js'
import type { MiniApp as MiniAppType } from '../src/pages/miniApp/miniApp.js'
import { describe, expect, it, vi } from 'vitest'
import { MiniApp } from '../src/pages/miniApp/miniApp.js'
import { Navigator } from '../src/pages/miniApp/navigator.js'
import { mergePageConfig } from '../src/utils/util.js'

describe('navigation foreground color', () => {
	it.each(['default', 'custom'])('keeps the title, capsule and host status bar aligned with %s navigation', navigationStyle => {
		const app = Object.create(MiniApp.prototype) as MiniAppType
		app.el = document.createElement('div')
		app.el.innerHTML = '<ul class="dimina-mini-app-navigation__actions"></ul>'
		const page = document.createElement('div')
		page.innerHTML = '<div class="dimina-native-webview__navigation"><h2 class="dimina-native-webview__navigation-title"></h2></div>'
		const navigation = page.firstElementChild as HTMLElement
		if (navigationStyle === 'custom') navigation.style.display = 'none'
		app.navigator = new Navigator()
		const configInfo = mergePageConfig({ window: { navigationBarTextStyle: 'black' } })
		app.navigator.pushPage({ opts: { pagePath: 'pages/index', configInfo }, webview: { el: page } } as unknown as Bridge)
		const updateStatusBarColor = vi.fn()
		app.parent = { updateStatusBarColor, getActiveView: () => app, isSleeping: false } as unknown as MiniAppType['parent']
		for (const [frontColor, mode, expected] of [['#ffffff', 'white', 'rgb(255, 255, 255)'], ['#000000', 'black', 'rgb(0, 0, 0)'], ['#FFFFFF', 'white', 'rgb(255, 255, 255)']]) {
			app.setNavigationBarColor({ frontColor, backgroundColor: '#26394d' })
			expect(navigation.querySelector<HTMLElement>('h2')!.style.color).toBe(expected)
			expect(app.el.querySelector('ul')!.classList.contains(`dimina-mini-app-navigation__actions--${mode}`)).toBe(true)
			expect(navigation.classList.contains(`dimina-native-webview__navigation--${mode}`)).toBe(true)
			expect(configInfo.navigationBarTextStyle).toBe(mode)
			expect(updateStatusBarColor).toHaveBeenLastCalledWith(mode)
		}
	})
})
