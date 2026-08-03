import { describe, expect, it, vi } from 'vitest'
import { MiniApp } from '../src/pages/miniApp/miniApp.js'
import { Navigator } from '../src/pages/miniApp/navigator.js'

// 契约《tabBar 畸形项最小容忍 v1》：
// 1. list 中缺 pagePath / pagePath 为空串或非字符串的项，初始化/渲染时整项跳过：
//    不出现在渲染出的 tab DOM 里，也不进入内部路径表（不可能被 switchTab 命中）。
// 2. 有效项不受影响：渲染数量 = 有效项数，选中态/切换行为与全部合法时一致。
// 3. 过滤后有效项为 0 时，视同未配置 tabBar（不渲染 tabBar 容器，不影响页面正常打开）。
// 4. 全部合法时行为与现状完全一致（回归保护）。
//
// 复用 navigation-callbacks.spec.ts 的先例：用 Object.create(MiniApp.prototype) 桩造一个
// 只填测试所需字段的 MiniApp 实例，绕开完整 openApp 链路直接调用 _initTabBar 等方法。
// 与该文件不同的是，这里给 el 用真实 DOM（而非 mock 的 el stub），因为要断言真实渲染出的
// tab DOM 数量/文案/点击行为，这些不是 customTabBar 分支能覆盖的。

function createHostEl(): HTMLElement {
	const el = document.createElement('div')
	el.className = 'dimina-mini-app'
	const tabbarContainer = document.createElement('div')
	tabbarContainer.className = 'dimina-mini-app__tabbar'
	tabbarContainer.style.display = 'none'
	el.appendChild(tabbarContainer)
	return el
}

function createApp(tabBar: unknown): MiniApp {
	// 与 navigation-callbacks.spec.ts 同样的桩造方式：字段之间彼此不满足真实类型约束，
	// 先按 Record<string, unknown> 自由赋值，最后统一 unknown 收窄回 MiniApp。
	const app: Record<string, unknown> = Object.create(MiniApp.prototype)
	app.el = createHostEl()
	app.appConfig = {
		app: { tabBar },
		modules: {},
	}
	app.tabBarConfig = null
	app.tabBarPaths = []
	app.tabBarBadges = []
	app.tabBarRedDots = []
	app.tabBarApiVisible = false
	app.customTabBar = false
	app.tabBarHeight = 0
	app.tabBarEl = null
	app.navigator = new Navigator()
	app.switchTab = vi.fn()
	return app as unknown as MiniApp
}

function itemTexts(app: MiniApp): string[] {
	return Array.from(app.el.querySelectorAll<HTMLElement>('.dimina-tabbar-item .dimina-tabbar-text'))
		.map(el => el.textContent ?? '')
}

function itemPaths(app: MiniApp): (string | undefined)[] {
	return Array.from(app.el.querySelectorAll<HTMLElement>('.dimina-tabbar-item'))
		.map(el => el.dataset.path)
}

describe('tabBar 畸形项最小容忍（契约 1）：缺失/空串/非字符串 pagePath 整项跳过', () => {
	it('缺 pagePath 的项：不进入渲染 DOM，也不进入内部路径表', () => {
		const app = createApp({
			list: [
				{ text: 'Dead' }, // 缺 pagePath
				{ pagePath: 'pages/first', text: 'First' },
			],
		})

		app._initTabBar()

		expect(app.tabBarPaths).toEqual(['pages/first'])
		expect(app.el.querySelectorAll('.dimina-tabbar-item')).toHaveLength(1)
		expect(itemTexts(app)).toEqual(['First'])
		// 路径表干净 -> 不可能被 switchTab 命中：normalize(undefined) === ''，
		// 若 '' 混进了 tabBarPaths，这里就会被误判为 tabBar 页
		expect(app._isTabBarPage('')).toBe(false)
	})

	it('pagePath 为空串的项：不进入渲染 DOM，也不进入内部路径表', () => {
		const app = createApp({
			list: [
				{ pagePath: '', text: 'Dead' },
				{ pagePath: 'pages/first', text: 'First' },
			],
		})

		app._initTabBar()

		expect(app.tabBarPaths).toEqual(['pages/first'])
		expect(app.el.querySelectorAll('.dimina-tabbar-item')).toHaveLength(1)
		expect(itemTexts(app)).toEqual(['First'])
	})

	it('pagePath 为非字符串（number / null）的项：不进入渲染 DOM，也不进入内部路径表', () => {
		const app = createApp({
			list: [
				{ pagePath: 123, text: 'DeadNumber' },
				{ pagePath: null, text: 'DeadNull' },
				{ pagePath: 'pages/first', text: 'First' },
			],
		})

		app._initTabBar()

		expect(app.tabBarPaths).toEqual(['pages/first'])
		expect(app.el.querySelectorAll('.dimina-tabbar-item')).toHaveLength(1)
		expect(itemTexts(app)).toEqual(['First'])
	})
})

describe('tabBar 畸形项最小容忍（契约 2）：有效项不受畸形项影响', () => {
	it('畸形项与有效项交错时，渲染数量/文案/顺序等于有效项本身（跳过项不占位）', () => {
		const app = createApp({
			list: [
				{ text: 'Dead1' }, // 缺 pagePath
				{ pagePath: 'pages/first', text: 'First' },
				{ pagePath: '', text: 'Dead2' },
				{ pagePath: 'pages/second', text: 'Second' },
			],
		})

		app._initTabBar()

		expect(app.tabBarPaths).toEqual(['pages/first', 'pages/second'])
		expect(app.el.querySelectorAll('.dimina-tabbar-item')).toHaveLength(2)
		expect(itemTexts(app)).toEqual(['First', 'Second'])
		expect(itemPaths(app)).toEqual(['pages/first', 'pages/second'])
	})

	it('点击有效项触发 switchTab 到正确路径；不存在可点击的死 tab', () => {
		const app = createApp({
			list: [
				{ text: 'Dead' }, // 缺 pagePath
				{ pagePath: 'pages/first', text: 'First' },
				{ pagePath: 'pages/second', text: 'Second' },
			],
		})

		app._initTabBar()
		app.navigator.setActiveTabPath('pages/first')

		// 死 tab 完全不应该出现在 DOM 里，不存在可点击的空路径项
		expect(app.el.querySelector('.dimina-tabbar-item[data-path=""]')).toBeNull()

		const items = app.el.querySelectorAll<HTMLElement>('.dimina-tabbar-item')
		items[1].dispatchEvent(new MouseEvent('click', { bubbles: true }))

		expect(app.switchTab).toHaveBeenCalledTimes(1)
		expect(app.switchTab).toHaveBeenCalledWith({ url: '/pages/second' })
	})

	it('选中态：过滤掉畸形项后，_updateTabBarSelection 仍然只高亮匹配路径的有效项', () => {
		const app = createApp({
			list: [
				{ text: 'Dead' },
				{ pagePath: 'pages/first', text: 'First' },
				{ pagePath: 'pages/second', text: 'Second' },
			],
		})

		app._initTabBar()
		app._updateTabBarSelection('pages/second')

		const items = app.el.querySelectorAll<HTMLElement>('.dimina-tabbar-item')
		expect(items).toHaveLength(2)
		expect(items[0].classList.contains('dimina-tabbar-item--selected')).toBe(false)
		expect(items[1].classList.contains('dimina-tabbar-item--selected')).toBe(true)
	})
})

describe('tabBar 畸形项最小容忍（契约 3）：过滤后有效项为 0 时视同未配置 tabBar', () => {
	it('list 全部畸形：不渲染 tabBar 容器，不进入内部路径表，且不抛错', () => {
		const app = createApp({
			list: [
				{ text: 'Dead1' }, // 缺 pagePath
				{ pagePath: '', text: 'Dead2' },
				{ pagePath: 123, text: 'Dead3' },
			],
		})

		expect(() => app._initTabBar()).not.toThrow()

		expect(app.tabBarPaths).toEqual([])
		expect(app.el.querySelectorAll('.dimina-tabbar-item')).toHaveLength(0)
		// 视同未配置 tabBar：容器内不应该出现任何渲染出的 tabbar 包裹节点
		expect(app.el.querySelectorAll('.dimina-tabbar')).toHaveLength(0)
	})
})

describe('tabBar 畸形项最小容忍（契约 4）：全部合法时行为与现状一致（回归保护）', () => {
	it('全部合法项：渲染数量/文案/路径表与配置一一对应', () => {
		const app = createApp({
			list: [
				{ pagePath: 'pages/first', text: 'First' },
				{ pagePath: 'pages/second', text: 'Second' },
			],
		})

		app._initTabBar()

		expect(app.tabBarPaths).toEqual(['pages/first', 'pages/second'])
		expect(app.el.querySelectorAll('.dimina-tabbar-item')).toHaveLength(2)
		expect(itemTexts(app)).toEqual(['First', 'Second'])
		expect(itemPaths(app)).toEqual(['pages/first', 'pages/second'])
	})

	it('全部合法项：点击第二项触发 switchTab 到对应路径', () => {
		const app = createApp({
			list: [
				{ pagePath: 'pages/first', text: 'First' },
				{ pagePath: 'pages/second', text: 'Second' },
			],
		})

		app._initTabBar()
		app.navigator.setActiveTabPath('pages/first')

		const items = app.el.querySelectorAll<HTMLElement>('.dimina-tabbar-item')
		items[1].dispatchEvent(new MouseEvent('click', { bubbles: true }))

		expect(app.switchTab).toHaveBeenCalledTimes(1)
		expect(app.switchTab).toHaveBeenCalledWith({ url: '/pages/second' })
	})
})
