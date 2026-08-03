import type { MiniApp } from '../src/pages/miniApp/miniApp.js'
import { describe, expect, it, vi } from 'vitest'
import { JSCore } from '../src/core/jscore.js'

// 契约：appShow()/appHide() 在服务线程真正可以处理它之前被调用时，不能被静默且永久
// 丢弃。真实的小程序服务线程要等入口页 serviceResourceLoaded（见 Bridge.messageInvoke
// 里 target === 'service' 分支）之后才会构造出 App 实例，appShow/appHide 最终都是靠
// runtime 调这个 App 实例的方法生效。在 jscore.init() 创建 Worker、到任意 Bridge 的
// service 资源加载完成之间，存在一个真实窗口：这段时间内发出的 appShow/appHide
// 消息会被服务线程的 app?.appHide() 可选链静默吞掉（app 还是 undefined），但 JSCore
// 自己的去重记账却把它标记成"已发送"，于是永远不会补发——小程序可能永久错过一次早期
// onHide()/onShow()，或者收到一次没有配对事件的迟到重复。
//
// 同样重要的反向约束：App() 构造本身就会同步触发一次隐式 onLaunch/onShow（对齐微信
// 官方语义），所以 notifyServiceReady() 触发那一刻的隐含基线是"已展示"，不是"什么都
// 没发过"——如果这期间沉淀下来的期望方向恰好也是"展示"（最常见的冷启动场景），
// 就绪后不应该在这个隐式 onShow 之上再叠加发一次显式 appShow，否则小程序会收到两次
// onShow。只有当沉淀下来的期望是"隐藏"时，才需要补发一次 appHide 把状态真正掰回去。
//
// 与现有 appshow-apphide-dedup.spec.ts 的 fixture 完全一致：伪造 parent + 直接把
// worker 设成可观测的桩，绕开真实 init()，只关注 appShow/appHide 的记账/补发逻辑。
function createJSCore(): { jscore: JSCore, workerPostMessage: ReturnType<typeof vi.fn> } {
	const fakeParent = { _destroyed: false } as unknown as MiniApp
	const jscore = new JSCore(fakeParent)
	const workerPostMessage = vi.fn()
	jscore.worker = { postMessage: workerPostMessage, terminate: vi.fn() } as unknown as Worker
	return { jscore, workerPostMessage }
}

describe('JSCore.appShow/appHide must not be dropped before the service runtime is ready', () => {
	it('records appHide called before service readiness without sending, then delivers it once notifyServiceReady() fires', () => {
		const { jscore, workerPostMessage } = createJSCore()

		jscore.appHide()

		// 服务线程还没就绪（还没有任何 Bridge 报告 serviceResourceLoaded），
		// 这次 appHide 只应该被记录为"期望状态"，不能真的发出去。
		expect(workerPostMessage).not.toHaveBeenCalled()

		// Bridge 在 serviceResourceLoaded 时应当通知 JSCore 服务线程已就绪；
		// 就绪后应当把刚才被压下的 appHide 补发出去。
		;(jscore as unknown as { notifyServiceReady: () => void }).notifyServiceReady()

		expect(workerPostMessage).toHaveBeenCalledTimes(1)
		expect(workerPostMessage).toHaveBeenCalledWith({ type: 'appHide', body: {} })
	})

	it('does not resend the same direction once it has already been flushed after readiness', () => {
		const { jscore, workerPostMessage } = createJSCore()

		jscore.appHide()
		;(jscore as unknown as { notifyServiceReady: () => void }).notifyServiceReady()
		expect(workerPostMessage).toHaveBeenCalledTimes(1)

		// 就绪之后再次调用同方向的 appHide：round-10 已确立的同方向去重契约依然成立。
		jscore.appHide()

		expect(workerPostMessage).toHaveBeenCalledTimes(1)
	})

	it('does not send anything once ready if the settled desired direction is appShow — App() construction already implies an initial onShow', () => {
		// 回归 round 12 codex 发现的问题：最常见的冷启动场景——presentView() 在
		// viewDidLoad()/jscore.init() 之前就调用了 onPresentIn()→appShow()，
		// desiredAppVisible 因此在服务就绪前就已经是 true。App() 构造本身已经
		// 隐式 onShow 过一次，就绪后如果还machine地补发一次显式 appShow，
		// 小程序会收到两次 onShow。
		const { jscore, workerPostMessage } = createJSCore()

		jscore.appShow()
		expect(workerPostMessage).not.toHaveBeenCalled()

		;(jscore as unknown as { notifyServiceReady: () => void }).notifyServiceReady()

		expect(workerPostMessage).not.toHaveBeenCalled()
	})

	it('only delivers the settled desired direction once ready when it differs from the implicit shown baseline, not every intermediate call made before readiness', () => {
		const { jscore, workerPostMessage } = createJSCore()

		jscore.appShow()
		jscore.appHide()

		// 服务线程仍未就绪：两次调用都只是记录期望方向，都不应该发送。
		expect(workerPostMessage).not.toHaveBeenCalled()

		;(jscore as unknown as { notifyServiceReady: () => void }).notifyServiceReady()

		// 就绪后只应该补发最终 settle 下来的期望方向（appHide，因为它与 App()
		// 构造隐式产生的"已展示"基线不同，需要被真正掰回隐藏）；不应该把中间
		// 路过的 appShow 也发出去——与 Bridge.desiredPageVisible/
		// #flushPageVisibility() 对页面级可见性信号的既有行为一致。
		expect(workerPostMessage).toHaveBeenCalledTimes(1)
		expect(workerPostMessage).toHaveBeenCalledWith({ type: 'appHide', body: {} })
	})
})
