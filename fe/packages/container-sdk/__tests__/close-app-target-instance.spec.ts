import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createContainer } from '../src/index.js'
import { resetFakeWorker } from './fixtures/fake-worker.js'
import { installFetchMock } from './fixtures/mock-fetch.js'

// 回归测试：closeApp(miniApp) 必须关闭调用方指定的实例，而不是永远关闭视图栈栈顶。
//
// 抓的 bug：AppManager.closeApp(miniApp) 把目标实例传给
// Application.dismissView()，但 dismissView() 内部硬编码操作
// this.views[this.views.length - 1]（栈顶），完全无视传入的目标。
// 栈为 [A, B] 时调用 closeApp(A)，实际被关闭的是栈顶的 B。

describe('closeApp(miniApp) targets the given instance, not always the top of the stack', () => {
	let mount: HTMLElement

	beforeEach(() => {
		installFetchMock()
		resetFakeWorker()
		mount = document.createElement('div')
		document.body.appendChild(mount)
	})

	it('closes a non-top instance and leaves the actual top instance open', async () => {
		const container = createContainer({ mount })

		const miniAppA = await container.openApp({ appId: 'wx-close-target-a', path: 'pages/index/index' })
		const miniAppB = await container.openApp({ appId: 'wx-close-target-b', path: 'pages/index/index' })

		expect(container.application.views).toEqual([miniAppA, miniAppB])

		container.closeApp(miniAppA)

		await vi.waitFor(() => {
			expect(container.application.views).toEqual([miniAppB])
		}, { timeout: 8000 })

		expect(container.application.getActiveView()).toBe(miniAppB)
		expect(miniAppB.el.isConnected).toBe(true)
	}, 10000)

	it('closing the top instance still plays the dismiss transition and reveals the one below it', async () => {
		const container = createContainer({ mount })

		const miniAppA = await container.openApp({ appId: 'wx-close-target-top-a', path: 'pages/index/index' })
		const miniAppB = await container.openApp({ appId: 'wx-close-target-top-b', path: 'pages/index/index' })

		container.closeApp(miniAppB)

		await vi.waitFor(() => {
			expect(container.application.views).toEqual([miniAppA])
		}, { timeout: 8000 })

		expect(container.application.getActiveView()).toBe(miniAppA)
	}, 10000)

	it('does not leave a stale --presenting class (40px rounded/scaled) on a non-top instance it just closed', async () => {
		const container = createContainer({ mount })

		const miniAppA = await container.openApp({ appId: 'wx-close-target-residue-a', path: 'pages/index/index' })
		await container.openApp({ appId: 'wx-close-target-residue-b', path: 'pages/index/index' })

		// A 被 B 顶到背后后，会带上 --presenting（缩放 + 40px 圆角）。
		await vi.waitFor(() => {
			expect(miniAppA.el.classList.contains('dimina-native-view--presenting')).toBe(true)
		}, { timeout: 8000 })

		container.closeApp(miniAppA)

		await vi.waitFor(() => {
			expect(container.application.views).not.toContain(miniAppA)
		}, { timeout: 8000 })

		// 非栈顶关闭没有退场动画，但呈现态遗留的 class 必须清掉，
		// 否则同 appId 再次 openApp 走缓存复用时，画面会带着残留的圆角/缩放呈现。
		expect(miniAppA.el.classList.contains('dimina-native-view--presenting')).toBe(false)
		expect(miniAppA.el.classList.contains('dimina-native-view--before-presenting')).toBe(false)
	}, 10000)
})
