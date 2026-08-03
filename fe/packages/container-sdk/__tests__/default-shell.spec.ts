import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createContainer, createDefaultShell } from '../src/index.js'
import { installFetchMock } from './fixtures/mock-fetch.js'

// createDefaultShell 公开契约（v1）：SDK 自带的默认宿主壳，实现 ShellAdapter，
// 渲染一条极简状态栏，宿主一行接入即可，省去自己实现 Device 类壳的成本。
//
// 本文件覆盖契约 1-6、8 条；第 7 条（样式随 scss 进构建产物）测试环境跑源码，
// 只断言状态栏根元素带约定 class 名，不断言具体视觉。

const TIME_FORMAT = /^([01]\d|2[0-3]):[0-5]\d$/

describe('createDefaultShell 创建（契约 1、7）', () => {
	it('无参可用：返回 ShellAdapter 形状，el 带约定 class 名', () => {
		const shell = createDefaultShell()

		expect(shell.el).toBeInstanceOf(HTMLElement)
		expect(typeof shell.getStatusBarRect).toBe('function')
		expect(typeof shell.updateStatusBarColor).toBe('function')
		expect(typeof shell.destroy).toBe('function')
		// 契约第 7 条：只断言约定 class 名存在，不断言具体视觉样式。
		expect(shell.el.classList.contains('dimina-default-shell__status-bar')).toBe(true)
	})

	it('传入 mount 时把 el 作为第一个子元素 prepend 进去，不覆盖已有内容', () => {
		const mount = document.createElement('div')
		const existingChild = document.createElement('span')
		existingChild.textContent = 'existing'
		mount.appendChild(existingChild)

		const shell = createDefaultShell({ mount })

		expect(mount.firstElementChild).toBe(shell.el)
		expect(mount.children).toHaveLength(2)
		expect(mount.contains(existingChild)).toBe(true)
	})

	it('不传 mount 时 el 不会被自动插入文档，交由宿主自行插入', () => {
		const shell = createDefaultShell()

		expect(shell.el.isConnected).toBe(false)
		expect(document.body.contains(shell.el)).toBe(false)
	})
})

describe('getStatusBarRect（契约 2）', () => {
	it('el 已连接文档时，返回值来自 el 的实时 getBoundingClientRect，而非内部硬编码值', () => {
		const mount = document.createElement('div')
		document.body.appendChild(mount)
		const shell = createDefaultShell({ mount })

		// 用一个和默认高度（44）明显不同的几何值，确认实现真的转发了
		// getBoundingClientRect 的结果，而不是套用契约第 2 条“未连接”分支的固定兜底值。
		const fakeRect = { top: 10, left: 5, width: 375, height: 51, right: 380, bottom: 61 } as DOMRect
		vi.spyOn(shell.el, 'getBoundingClientRect').mockReturnValue(fakeRect)

		expect(shell.getStatusBarRect()).toEqual(fakeRect)
	})

	it('el 未连接文档时，返回 {top:0,left:0,right:0,width:0,height:H,bottom:H}（H 为配置高度）而不抛错，默认 H=44', () => {
		const shell = createDefaultShell()

		expect(() => shell.getStatusBarRect()).not.toThrow()
		expect(shell.getStatusBarRect()).toEqual({ top: 0, left: 0, right: 0, width: 0, height: 44, bottom: 44 })
	})

	it('el 未连接文档且自定义 height 时，兜底矩形的 height/bottom 跟随配置高度', () => {
		const shell = createDefaultShell({ height: 60 })

		expect(shell.getStatusBarRect()).toEqual({ top: 0, left: 0, right: 0, width: 0, height: 60, bottom: 60 })
	})
})

describe('updateStatusBarColor（契约 3）', () => {
	it('black / white 互斥切换修饰 class', () => {
		const shell = createDefaultShell()

		shell.updateStatusBarColor('black')
		expect(shell.el.classList.contains('dimina-default-shell__status-bar--black')).toBe(true)
		expect(shell.el.classList.contains('dimina-default-shell__status-bar--white')).toBe(false)

		shell.updateStatusBarColor('white')
		expect(shell.el.classList.contains('dimina-default-shell__status-bar--white')).toBe(true)
		expect(shell.el.classList.contains('dimina-default-shell__status-bar--black')).toBe(false)
	})

	it('其它取值被忽略、不抛错，且不改变已有的修饰 class', () => {
		const shell = createDefaultShell()
		shell.updateStatusBarColor('black')

		expect(() => shell.updateStatusBarColor('red')).not.toThrow()
		expect(shell.el.classList.contains('dimina-default-shell__status-bar--black')).toBe(true)
		expect(shell.el.classList.contains('dimina-default-shell__status-bar--red')).toBe(false)
	})
})

describe('showTime（契约 4）', () => {
	it('默认 true：el 内存在一个文本为 HH:MM 格式（24 小时制）的时间元素', () => {
		const shell = createDefaultShell()

		expect(shell.el.textContent).toMatch(TIME_FORMAT)
	})

	it('showTime: false 时不渲染任何时间文本', () => {
		const shell = createDefaultShell({ showTime: false })

		expect(TIME_FORMAT.test(shell.el.textContent ?? '')).toBe(false)
	})
})

describe('destroy（契约 5）', () => {
	it('把 el 从 DOM 移除', () => {
		const mount = document.createElement('div')
		document.body.appendChild(mount)
		const shell = createDefaultShell({ mount })

		expect(mount.contains(shell.el)).toBe(true)
		shell.destroy()
		expect(mount.contains(shell.el)).toBe(false)
		expect(shell.el.isConnected).toBe(false)
	})

	it('重复调用 destroy 是幂等的，不抛错', () => {
		const mount = document.createElement('div')
		document.body.appendChild(mount)
		const shell = createDefaultShell({ mount })

		shell.destroy()
		expect(() => shell.destroy()).not.toThrow()
	})

	it('停止内部计时器：destroy 之后即使时间推进，时间文本也不再更新', () => {
		vi.useFakeTimers()
		try {
			vi.setSystemTime(new Date('2026-07-21T10:00:30'))
			const shell = createDefaultShell({ showTime: true })
			const initialText = shell.el.textContent

			// 先推进跨过一次分钟边界，证明计时器确实在运行、文本会被更新，
			// 否则下面 destroy 之后“文本不再变化”的断言可能只是恒真（计时器压根没在跑）。
			vi.setSystemTime(new Date('2026-07-21T10:02:00'))
			vi.advanceTimersByTime(90_000)
			const updatedText = shell.el.textContent
			expect(updatedText).not.toBe(initialText)

			shell.destroy()

			vi.setSystemTime(new Date('2026-07-21T10:05:00'))
			vi.advanceTimersByTime(180_000)
			expect(shell.el.textContent).toBe(updatedText)
		}
		finally {
			vi.useRealTimers()
		}
	})
})

describe('与 createContainer 集成（契约 6）', () => {
	let mount: HTMLElement
	let shellHost: HTMLElement

	beforeEach(() => {
		installFetchMock()
		mount = document.createElement('div')
		document.body.appendChild(mount)
		shellHost = document.createElement('div')
		document.body.appendChild(shellHost)
	})

	it('createContainer 启动过程中读取的状态栏几何来自 defaultShell.el，且方法以裸函数引用调用也正常', async () => {
		const defaultShell = createDefaultShell({ mount: shellHost })
		const fakeRect = { top: 0, left: 0, width: 375, height: 51, right: 375, bottom: 51 } as DOMRect
		vi.spyOn(defaultShell.el, 'getBoundingClientRect').mockReturnValue(fakeRect)

		// 契约第 6 条明确要求：即便把方法当裸函数引用调用（无 this 接收者）也必须正常，
		// 因为 createDefaultShell 是工厂闭包实现，不依赖 this。这里直接解构出裸函数
		// 传给 createContainer，复刻这种调用方式。
		const { getStatusBarRect, updateStatusBarColor } = defaultShell
		const container = createContainer({ mount, shell: { getStatusBarRect, updateStatusBarColor } })

		const miniApp = await container.openApp({ appId: 'wx-default-shell-rect', path: 'pages/index/index' })

		expect(miniApp.getSystemInfoSync().statusBarHeight).toBe(51)
	}, 10000)

	it('页面 navigationBarTextStyle 解析结果会驱动 defaultShell 状态栏的颜色修饰 class', async () => {
		const defaultShell = createDefaultShell({ mount: shellHost })
		const container = createContainer({ mount, shell: defaultShell })

		await container.openApp({ appId: 'wx-default-shell-color', path: 'pages/index/index' })

		// fixtures/app-config.js 的最小配置未设置 window.navigationBarTextStyle，
		// SDK 侧（utils/util.ts）缺省解析为 'white'，最终应体现为 el 上的 --white 修饰 class。
		await vi.waitFor(() => {
			expect(defaultShell.el.classList.contains('dimina-default-shell__status-bar--white')).toBe(true)
		}, { timeout: 8000 })
		expect(defaultShell.el.classList.contains('dimina-default-shell__status-bar--black')).toBe(false)
	}, 10000)
})

describe('零配置路径不变（契约 8）', () => {
	it('不传 shell 时 createContainer 行为与现状一致：不会隐式创建默认状态栏元素', async () => {
		installFetchMock()
		const mount = document.createElement('div')
		document.body.appendChild(mount)

		const container = createContainer({ mount })
		const miniApp = await container.openApp({ appId: 'wx-no-shell', path: 'pages/index/index' })

		expect(miniApp.getSystemInfoSync().statusBarHeight).toBe(0)
		expect(mount.querySelector('.dimina-default-shell__status-bar')).toBeNull()
	}, 10000)
})
