import type { MiniApp } from '../src/pages/miniApp/miniApp.js'
import { describe, expect, it, vi } from 'vitest'
import { Application } from '../src/pages/application/application.js'

// fake view 只填 _presentView/_dismissView 实际会摸到的最小字段集：Application.el 是
// 真实 DOM 节点，故 view.el 用真实 document.createElement 而不是纯桩对象。与
// application-partial-failure-recovery.spec.ts / application-transition-integrity.spec.ts
// 保持同一 fixture 形状。

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

// 契约：Application 处于 sleeping 状态时，_presentView()/_dismissView() 都不能
// 把某个 view 标记为已呈现前台——这跟 application-remove-failed-view-sleeping-gate.spec.ts
// 守护的 removeFailedView() 是同一条原则。真正的前台恢复统一等
// wakeActiveView() 之后再发生。

describe('Application._presentView does not fire onPresentIn() while the app is sleeping', () => {
	it('does not call view.onPresentIn() when presentView() runs with isSleeping=true', async () => {
		const application = new Application({ urlSync: { syncStack: vi.fn(), clear: vi.fn() } })
		application.isSleeping = true

		const viewA = createFakeView('app-a')
		await application.presentView(viewA, false)

		expect(application.views).toEqual([viewA])
		// 应用自称"已睡眠"期间，_presentView() 的正常呈现分支不能把 viewA
		// 标记为已呈现前台。
		expect(viewA.onPresentIn).not.toHaveBeenCalled()
	}, 10000)

	it('calls view.onPresentOut() instead, so the app-level visibility ends up recorded as hidden rather than left unset', async () => {
		// service 侧构造小程序的 App 实例时会自动展示一次（对齐微信官方语义）。
		// 如果休眠期间新呈现的实例不显式记录"应处于隐藏"这个期望，真正唤醒时
		// jscore 会因为查不到"之前隐藏过"的记录，误以为不需要再补发一次展示，
		// 导致小程序把这整段休眠期都当成前台在展示。_presentView() 因此必须
		// 显式调用 onPresentOut()，把这个新实例的期望状态设成隐藏。
		const application = new Application({ urlSync: { syncStack: vi.fn(), clear: vi.fn() } })
		application.isSleeping = true

		const viewA = createFakeView('app-a')
		await application.presentView(viewA, false)

		expect(viewA.onPresentOut).toHaveBeenCalledTimes(1)
	}, 10000)
})

describe('Application._dismissView does not fire onPresentIn() on the revealed predecessor while the app is sleeping', () => {
	it('does not call viewA.onPresentIn() when dismissView(viewB) reveals viewA with isSleeping=true', async () => {
		const application = new Application({ urlSync: { syncStack: vi.fn(), clear: vi.fn() } })

		const viewA = createFakeView('app-a')
		const viewB = createFakeView('app-b')

		// 正常搭建阶段：isSleeping 仍是 false，viewA/viewB 的初始呈现按正常
		// 生命周期走完，不受本测试关心的 gate 影响。
		await application.presentView(viewA, false)
		await application.presentView(viewB, false)
		expect(application.views).toEqual([viewA, viewB])

		// 清空搭建阶段遗留的调用记录——后面只关心 dismissView(viewB) 这次调用
		// 自己有没有再触发 viewA.onPresentIn()。
		viewA.onPresentIn = vi.fn()

		application.isSleeping = true

		await application.dismissView(viewB, { destroy: true })

		expect(application.views).toEqual([viewA])
		// 应用自称"已睡眠"期间，_dismissView() 摘除栈顶后不能把露出来的 viewA
		// 标记为已呈现前台。
		expect(viewA.onPresentIn).not.toHaveBeenCalled()
	}, 10000)
})
