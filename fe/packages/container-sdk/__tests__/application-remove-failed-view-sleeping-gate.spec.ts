import type { MiniApp } from '../src/pages/miniApp/miniApp.js'
import { describe, expect, it, vi } from 'vitest'
import { Application } from '../src/pages/application/application.js'

// fake view 只填 removeFailedView 实际会摸到的最小字段集：Application.el 是真实 DOM
// 节点，故 view.el 用真实 document.createElement 而不是纯桩对象。与
// application-adapter-failure-isolation.spec.ts 里 "restores viewA to foreground..."
// 那个测试保持同一 fixture/setup 形状（同样是把 viewB 直接 push 进 application.views
// 模拟一个尚未走完 presentView() 就失败的新实例）。

function createFakeView(appId: string, overrides: Partial<Record<string, unknown>> = {}): MiniApp {
	const view: Record<string, unknown> = {
		appId,
		el: document.createElement('div'),
		parent: null,
		onPresentIn: vi.fn(),
		onPresentOut: vi.fn(),
		viewDidLoad: vi.fn(),
		restoreColorStyle: vi.fn(),
		destroy: vi.fn(),
		getPageStack: vi.fn(() => []),
		...overrides,
	}
	return view as unknown as MiniApp
}

// 契约：removeFailedView() 摘除一个原本在栈顶的失败实例后，会把新栈顶（前一个实例）
// 恢复到前台——但它无条件调用 newTop.onPresentIn()，完全不检查 this.isSleeping。
// Application.sleepActiveView() 置位 isSleeping=true 并让当前活跃 view 退到后台，
// 但不碰 this.views；wakeActiveView() 之后会在真正唤醒时对彼时的活跃 view 补一次
// restoreColorStyle()+onPresentIn()。如果应用在某个 view 正尝试呈现失败的过程中被
// 切到后台（isSleeping=true），removeFailedView() 的这次"恢复前台"不应该立刻对
// 前一个实例触发前台生命周期——那会让它在整个应用自称"已退到后台"的同时被标记为
// "已呈现"，真正的前台恢复应该等 wakeActiveView() 之后再发生，和一个本来就还在
// 正常前台的 view 睡眠再唤醒时的行为完全一致。

describe('Application.removeFailedView() does not fire onPresentIn() on the restored predecessor while the app is sleeping', () => {
	it('does not call viewA.onPresentIn() again when removeFailedView(viewB) runs with isSleeping=true', async () => {
		const application = new Application({ urlSync: { syncStack: vi.fn(), clear: vi.fn() } })

		const viewA = createFakeView('app-a')
		await application.presentView(viewA, false)
		expect(application.views).toEqual([viewA])

		// presentView() 本身已经调用过一次 viewA.onPresentIn()——清空调用记录，
		// 后面只关心 removeFailedView() 这次调用有没有再触发它。
		viewA.onPresentIn = vi.fn()

		// viewB 是即将失败的新实例：尚未经过 presentView() 的完整呈现流程，直接被
		// 上游放进展示栈（对照 application-adapter-failure-isolation.spec.ts 里同一
		// 场景的 fixture 手法）。
		const viewB = createFakeView('app-b')
		application.views.push(viewB)

		// 应用在 viewB 呈现失败的过程中被切到后台。
		application.isSleeping = true

		await application.removeFailedView(viewB)

		expect(application.views).toEqual([viewA])
		// 今天的 bug：removeFailedView() 无条件调用 newTop.onPresentIn()，不检查
		// isSleeping，viewA 会在应用仍然自称"已睡眠"的情况下被立刻标记为前台呈现。
		expect(viewA.onPresentIn).not.toHaveBeenCalled()
	}, 10000)
})
