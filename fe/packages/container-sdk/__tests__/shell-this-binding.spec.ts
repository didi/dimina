import type { StatusBarRect } from '../src/index.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createContainer } from '../src/index.js'
import { installFetchMock } from './fixtures/mock-fetch.js'

// 回归测试：shell 适配器方法必须保留宿主实例的 this 绑定。
//
// 宿主常把 shell 适配器实现成 class 实例，getStatusBarRect / updateStatusBarColor
// 内部读的是自己实例上的状态。如果 SDK 把这两个方法当"裸函数引用"抠出来调用
// （例如 const fn = shell.getStatusBarRect; fn()，或者以 SDK 内部某个对象为
// receiver 调用），宿主方法里的 this 就不是宿主实例了——真机上表现为一打开
// 小程序就 TypeError 崩溃（真实浏览器验证发现的两个 bug 之一）。
//
// 用 JS 私有字段（#field）承载宿主状态：只要调用时的 receiver 不是这个宿主实例
// 本身，访问私有字段必定抛 TypeError——比 this._x 这种可被其他对象"凑巧满足形状"
// 的写法更能精确抓住"this 丢失"，不会因为 SDK 恰好传了个长得像的 receiver 而漏报。
class HostShellAdapter {
	#statusBarRect: StatusBarRect
	#colorLog: string[] = []

	constructor(rect: StatusBarRect) {
		this.#statusBarRect = rect
	}

	getStatusBarRect(): StatusBarRect {
		return this.#statusBarRect
	}

	updateStatusBarColor(color: string): void {
		this.#colorLog.push(color)
	}

	get colorLog(): string[] {
		return this.#colorLog
	}
}

describe('shell adapter preserves host `this` binding', () => {
	let mount: HTMLElement

	beforeEach(() => {
		installFetchMock()
		mount = document.createElement('div')
		document.body.appendChild(mount)
	})

	it('opens an app and reads the status bar rect with the host instance as receiver', async () => {
		const host = new HostShellAdapter({ top: 20, left: 0, width: 375, height: 44, right: 375, bottom: 64 })
		const container = createContainer({ mount, shell: host })

		const miniApp = await container.openApp({ appId: 'wx-shell-this-rect', path: 'pages/index/index' })

		expect(miniApp).toBeTruthy()
		expect(() => miniApp.getSystemInfoSync()).not.toThrow()
		expect(miniApp.getSystemInfoSync().statusBarHeight).toBe(44)
	}, 10000)

	it('notifies status bar color changes with the host instance as receiver during boot', async () => {
		const host = new HostShellAdapter({ top: 20, left: 0, width: 375, height: 44, right: 375, bottom: 64 })
		const container = createContainer({ mount, shell: host })

		await container.openApp({ appId: 'wx-shell-this-color', path: 'pages/index/index' })

		await vi.waitFor(() => {
			expect(host.colorLog.length).toBeGreaterThan(0)
		}, { timeout: 8000 })
	}, 10000)
})
