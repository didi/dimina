import type { MiniApp as MiniAppType } from '../src/pages/miniApp/miniApp.js'
import { describe, expect, it, vi } from 'vitest'
import { MiniApp } from '../src/pages/miniApp/miniApp.js'

// 契约：MiniApp.updateActionColorStyle() 是所有配色提交路径唯一收敛到宿主
// shell.updateStatusBarColor() 的地方——navigateTo/redirectTo/switchTab/
// reLaunch/restorePageStack/initApp/showLaunchScreen/restoreColorStyle 全部
// 经它调用。今天它在 isPresentedTop() 为真时无防护地直接调用
// `this.parent!.updateStatusBarColor(color!)`：宿主适配器抛错会原样从
// updateActionColorStyle() 冒泡出去，中断调用方尚未跑完的其余提交工作。
//
// 真实触发场景：Application._presentView() 对非缓存呈现（useCache: false）
// 会先把新 view 无条件提交进 DOM/展示栈（this.el.appendChild(view.el)、
// this.views.push(view)），再同步调用 view.viewDidLoad()——它立刻调用
// showLaunchScreen() → updateActionColorStyle('black')。如果此时宿主的
// shell.updateStatusBarColor 抛错，异常会一路冒泡穿透 viewDidLoad()，
// 顶出 _presentView() 的 try 块之外，而此刻这个 view 早已经真实提交进
// DOM 和展示栈——presentView() 的整个 Promise 因为一次纯旁路的宿主适配器
// 故障而 reject，且再次呈现同一个（已经是栈顶的）view 会命中幂等短路分支
// 直接跳过，viewDidLoad()/initApp() 永远不会被重跑，留下一个"已提交但从未
// 真正初始化"的僵尸实例。
//
// 与 Application.safeSyncUrl()/safeRestoreColorStyle() 对宿主 urlSync/
// shell.updateStatusBarColor 的收窄同一契约：宿主可控代码抛错是一次
// best-effort 旁路失败，必须在它的单一源头被完全吸收，不能向任何调用方
// 传播——这样每一条经 updateActionColorStyle() 汇入的路径都自动获得防护，
// 不需要在 8 个调用方各自补一份 try/catch。

function createActionEl() {
	return { classList: { add: vi.fn(), remove: vi.fn() } }
}

function createApp(): MiniAppType {
	const app: Record<string, unknown> = Object.create(MiniApp.prototype)
	const actionEl = createActionEl()
	app.el = { querySelector: vi.fn(() => actionEl) } as unknown as HTMLElement
	return app as unknown as MiniAppType
}

describe('MiniApp.updateActionColorStyle() absorbs a throwing host updateStatusBarColor callback', () => {
	it('does not propagate the throw, and still commits this.color and the local CSS class toggle', () => {
		const app = createApp()

		const updateStatusBarColor = vi.fn(() => {
			throw new Error('status-bar-boom')
		})
		app.parent = {
			updateStatusBarColor,
			getActiveView: vi.fn(() => app),
			isSleeping: false,
		} as unknown as MiniAppType['parent']

		// crux 1：宿主适配器抛错必须被 updateActionColorStyle() 自己吸收，不能
		// 冒泡出去中断调用方（viewDidLoad()/showLaunchScreen() 及其上游
		// _presentView()）尚未跑完的其余提交工作。
		expect(() => app.updateActionColorStyle('black')).not.toThrow()

		// crux 2：即使宿主回调抛错，方法自身的状态提交（this.color）仍必须
		// 真实发生——不能因为后续的 updateStatusBarColor 调用失败就回滚成
		// "整个方法都没做过"的假象。
		expect(app.color).toBe('black')
		expect(updateStatusBarColor).toHaveBeenCalledWith('black')

		// crux 3：本地 CSS class 切换（与宿主状态栏配色是否成功无关的纯本地
		// 渲染状态）同样必须真实发生。
		const actionEl = (app.el.querySelector as unknown as ReturnType<typeof vi.fn>).mock.results[0]!.value as ReturnType<typeof createActionEl>
		expect(actionEl.classList.remove).toHaveBeenCalledWith('dimina-mini-app-navigation__actions--white')
		expect(actionEl.classList.add).toHaveBeenCalledWith('dimina-mini-app-navigation__actions--black')
	})
})
