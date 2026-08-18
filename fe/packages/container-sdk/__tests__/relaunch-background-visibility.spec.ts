import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createContainer } from '../src/index.js'
import { FakeWorker, resetFakeWorker } from './fixtures/fake-worker.js'
import { installFetchMock } from './fixtures/mock-fetch.js'

// 回归测试：MiniApp.reLaunch() 不受 Application 那条串行 _enqueue() 队列约束
// （只有 presentView()/dismissView() 经过那条队列），所以一个已经被压到栈底、
// 不再是 Application.views 栈顶的 MiniApp 实例，仍然可以调用 reLaunch()。
//
// reLaunch() 的成功分支（miniApp.ts）在新入口页 bridge 就绪后无条件调用
// `bridge.start()`——不带任何 options。对比同一个文件里 initApp() 的写法：
// entryPageBridge.start({ visible: !isRestoringPageStack })，会显式算出并
// 传入可见性。Bridge.start()（core/bridge.ts）的契约是：options 里没有
// 'visible' 这个 key、且 desiredPageVisible 还是刚构造时的 null（全新 bridge
// 必然如此），就缺省为可见——不看这个 MiniApp 实例当前是否真的在
// Application.views 栈顶。
//
// 后果：一个当前被别的小程序盖住的（后台）MiniApp 调 reLaunch()，它刚建好的
// 新入口页 bridge 会被当成"可见"来启动，一旦资源加载握手完成就会给逻辑线程
// 发 pageShow——即便这个页面这一刻根本没有被用户看到。
//
// 用真实的两个 openApp() 而不是对 Bridge.prototype.start 打桩：先正常打开 A，
// 再正常打开 B（B 落到 Application.views 栈顶，A 被 onPresentOut() 推到后台），
// 全程走真实的 webview/worker 握手（setup.js 的 MutationObserver 桩），不引入
// 人为的异步延时/race，确定性、不 flaky。然后对已经在后台的 A 调用
// reLaunch()，等它的新 bridge 就绪，直接检查该 bridge 实例的可见性意图，并
// 补一段协议级验证：手动喂它 serviceResourceLoaded + renderResourceLoaded
// 确认握手，看它是否真的会把 pageShow 发给逻辑线程。

async function waitForNextWorker(startIndex: number, timeout = 8000) {
	await vi.waitFor(() => {
		expect(FakeWorker.instances.length).toBeGreaterThan(startIndex)
	}, { timeout })
	return FakeWorker.instances[startIndex]
}

interface PostedMessage { type: string, body?: { id?: unknown, bridgeId?: unknown, args?: { errMsg?: string } } }

function findTriggerCallback(worker: InstanceType<typeof FakeWorker>, id: string): PostedMessage | undefined {
	const call = (worker.postMessage.mock.calls as [PostedMessage][]).find(
		([message]) => message?.type === 'triggerCallback' && message?.body?.id === id,
	)
	return call ? call[0] : undefined
}

async function waitForTriggerCallback(worker: InstanceType<typeof FakeWorker>, id: string, timeout = 8000): Promise<PostedMessage> {
	return vi.waitFor(() => {
		const message = findTriggerCallback(worker, id)
		if (!message) throw new Error(`triggerCallback with id "${id}" was not posted yet`)
		return message
	}, { timeout })
}

describe('reLaunch() on a backgrounded MiniApp must not start its new bridge as visible', () => {
	let mount: HTMLElement

	beforeEach(() => {
		installFetchMock()
		resetFakeWorker()
		mount = document.createElement('div')
		document.body.appendChild(mount)
	})

	it('keeps the new bridge non-visible when a different app is the presented top', async () => {
		const APP_A = 'wx-relaunch-bg-a'
		const APP_B = 'wx-relaunch-bg-b'

		const container = createContainer({ mount })

		const miniAppA = await container.openApp({ appId: APP_A, path: 'pages/index/index' })
		const workerA = await waitForNextWorker(0)

		await vi.waitFor(() => {
			expect(miniAppA.navigator.getStack()).toHaveLength(1)
		}, { timeout: 8000 })

		// 打开第二个 app：Application.presentView() 把它压到栈顶，同步调用
		// preView(A).onPresentOut()，A 正式沦为后台实例。
		const miniAppB = await container.openApp({ appId: APP_B, path: 'pages/index/index' })
		await vi.waitFor(() => {
			expect(miniAppB.navigator.getStack()).toHaveLength(1)
		}, { timeout: 8000 })

		// 前提：A 现在确实是后台，B 才是 Application.views 的栈顶。
		expect(container.application.views.at(-1)).toBe(miniAppB)
		expect(container.application.views.includes(miniAppA)).toBe(true)
		expect(container.application.views.at(-1)).not.toBe(miniAppA)

		// 对仍在后台的 A 调用 reLaunch()（没有被 Application 的队列拦住）。
		miniAppA.reLaunch({
			url: '/pages/index/index',
			success: 'relaunch-bg-success',
			fail: 'relaunch-bg-fail',
			complete: 'relaunch-bg-complete',
		})

		await waitForTriggerCallback(workerA, 'relaunch-bg-success')
		expect(findTriggerCallback(workerA, 'relaunch-bg-fail')).toBeUndefined()

		// reLaunch 成功之后，A 的 navigator 顶上是刚建好的新入口页 bridge。
		const newBridge = miniAppA.navigator.top!
		expect(newBridge).toBeTruthy()

		// B 仍然是当前展示栈顶，A 依旧在后台——这一次 reLaunch 完全没有让 A
		// 重新变回前台。
		expect(container.application.views.at(-1)).toBe(miniAppB)

		// crux #1：新 bridge 的可见性意图不能是"可见"。当前代码里 reLaunch()
		// 的 .then() 分支调用 `bridge.start()`（不带 options），Bridge.start()
		// 对一个全新构造、desiredPageVisible 仍是 null 的 bridge 会缺省为
		// true——这正是要守护住的回归点。
		expect(newBridge.desiredPageVisible).not.toBe(true)

		// crux #2：协议级验证——手动喂完 serviceResourceLoaded + renderResourceLoaded
		// （模拟渲染层/逻辑线程真实回执握手完成），确认它确实不会把 pageShow
		// 发给逻辑线程 worker。
		workerA.postMessage.mockClear()
		newBridge.messageInvoke('service', {
			type: 'serviceResourceLoaded',
			target: 'service',
			body: { bridgeId: newBridge.id, resourceLoadId: newBridge.resourceLoadId },
		})
		newBridge.messageInvoke('render', {
			type: 'renderResourceLoaded',
			target: 'service',
			body: { bridgeId: newBridge.id, resourceLoadId: newBridge.resourceLoadId },
		})

		const postedTypes = (workerA.postMessage.mock.calls as [PostedMessage][]).map(([message]) => message.type)
		expect(postedTypes).not.toContain('pageShow')
	}, 15000)
})
