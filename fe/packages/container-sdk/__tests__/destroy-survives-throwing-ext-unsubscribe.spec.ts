import { beforeEach, describe, expect, it, vi } from 'vitest'
import { JSCore } from '../src/core/jscore.js'
import { createContainer } from '../src/index.js'
import { ENTRY_PAGE_PATH } from './fixtures/app-config.js'
import { FakeWorker, resetFakeWorker } from './fixtures/fake-worker.js'
import { installFetchMock } from './fixtures/mock-fetch.js'

// 契约：MiniApp.destroy() 现在是被多条失败路径复用的强制收尾（initApp() 的 catch
// 分支、正常 closeMiniProgram()/dismissView() 等），不再只是"正常关闭"专属的收尾。
// 它的第一步就是同步置位 _destroyed = true，随后依次做：中止在途 bridge.init() →
// 逐个调用 _extSubscriptions 里登记的 unsubscribe → 清 resize/主题/弹窗等资源 →
// this.parent?.appManager?.removeApp(this) → this.jscore.destroy()。
//
// _extSubscriptions 里的 unsubscribe 函数由第三方扩展模块（ExtModuleHandler，见
// types.ts）自己返回，不受这个实例控制——service 侧 extOnBridge 每次调用都经
// _extOnBridgeCall() 把扩展模块返回的 unsubscribe 存进这张表，等 extOffBridge 或
// destroy() 时被调用。destroy() 里遍历这张表调用 unsubscribe() 时没有包一层
// try/catch：只要其中任意一个 unsubscribe 抛错，for...of 循环整体中断，排在它
// 后面的 appManager.removeApp(this) 和 jscore.destroy() 都不会被执行——
// _destroyed 已经在最开始被置为 true，但 Worker 从未终止、AppManager 登记表
// 也从未摘除，"已销毁"的实例实际上只销毁了一半。
//
// 期望：一个行为不当的扩展模块（unsubscribe 抛错）不能卡死 destroy() 后面
// 排队的关键收尾步骤——AppManager 登记表摘除、JSCore Worker 终止必须照常发生。
//
// 手法：走真实 createContainer + 真实 webview/worker 握手正常打开一个 app（不
// 制造启动失败），经公开的 invokeApi() 入口按 service 侧 extOnBridge 协议
// （见 miniApp.ts _handleExtCall 上方注释：name=`${module}_${event}`,
// params={success, evtId}）真实触发 _extOnBridgeCall()，让扩展模块自己返回的
// unsubscribe（这里故意让它抛错）被真实存进 _extSubscriptions，而不是直接摆一个
// mock 进私有字段。

describe('MiniApp.destroy() survives a throwing extension-module unsubscribe function', () => {
	let mount: HTMLElement

	beforeEach(() => {
		installFetchMock()
		resetFakeWorker()
		mount = document.createElement('div')
		document.body.appendChild(mount)
	})

	it('still removes the AppManager registry entry and terminates the JSCore Worker when an ext-module unsubscribe throws', async () => {
		const APP_ID = 'wx-destroy-throwing-unsubscribe'
		const jscoreDestroySpy = vi.spyOn(JSCore.prototype, 'destroy')

		const throwingUnsubscribe = vi.fn(() => {
			throw new Error('unsubscribe exploded')
		})
		// ExtModuleHandler 的真实形状（types.ts）：payload -> unsubscribe | void。
		const extModuleHandler = vi.fn(() => throwingUnsubscribe)

		const container = createContainer({
			mount,
			extModules: { myExtModule: extModuleHandler },
		})

		const miniApp = await container.openApp({ appId: APP_ID, path: ENTRY_PAGE_PATH })

		// 前提：这个实例真的启动成功、真的持有一个 Worker——不是在一个已经失败
		// 的半成品实例上测 destroy()，这条 crux 才有意义。
		await vi.waitFor(() => {
			expect(FakeWorker.instances.length).toBeGreaterThan(0)
		}, { timeout: 8000 })
		expect(container.application.appManager.getAppById(APP_ID)).toBe(miniApp)

		// service 侧 extOnBridge 协议：name = `${module}_${event}`，
		// params = { success: <回调标识>, evtId }。success 只需 truthy 即可让
		// _handleExtCall 路由到 _extOnBridgeCall（真实实现按 truthy 判断，不
		// 校验具体类型）。
		miniApp.invokeApi('myExtModule_someEvent', { success: 1, evtId: 'evt-1' })

		// 前提：扩展模块的 unsubscribe 真的被 _extOnBridgeCall() 存进了
		// _extSubscriptions——不是测试直接摆一个假条目进去。
		expect(extModuleHandler).toHaveBeenCalledTimes(1)
		expect(miniApp._extSubscriptions.get('myExtModule_someEvent')).toBe(throwingUnsubscribe)

		// destroy() 这一次调用本身抛错是预期内的（unsubscribe 抛错会从 for...of
		// 循环里逃逸）；crux 不在这里，而在于抛错之后排在它后面的收尾步骤是否
		// 依然完整跑完。
		expect(() => miniApp.destroy()).toThrow('unsubscribe exploded')
		expect(throwingUnsubscribe).toHaveBeenCalledTimes(1)

		// _destroyed 在 destroy() 最开始就同步置位，不受后续抛错影响。
		expect(miniApp._destroyed).toBe(true)

		// crux 1：AppManager 登记表必须摘除这个实例，不能让一个"已销毁"的实例
		// 继续占着 appId 的登记位。
		expect(container.application.appManager.getAppById(APP_ID)).toBeNull()

		// crux 2：这个实例自己的 Worker 必须被终止，不能被排在它前面、行为不当的
		// 扩展模块卡住。
		expect(jscoreDestroySpy).toHaveBeenCalledTimes(1)
		expect(jscoreDestroySpy).toHaveBeenCalledWith()
		expect(FakeWorker.instances[0].terminate).toHaveBeenCalledTimes(1)
	}, 15000)
})
