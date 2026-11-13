import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createContainer } from '../src/index.js'
import { installFetchMock } from './fixtures/mock-fetch.js'
import type { MiniApp } from '../src/pages/miniApp/miniApp.js'

function createView(): MiniApp {
	return {
		appId: 'wx-window-presentation',
		el: document.createElement('div'),
		onPresentIn: vi.fn(),
		onPresentOut: vi.fn(),
		destroy: vi.fn(),
	} as unknown as MiniApp
}

describe('host mini program dismissal', () => {
	beforeEach(() => installFetchMock())
	it('notifies the host after the application has left the stack', async () => {
		const mount = document.createElement('div')
		document.body.appendChild(mount)
		const onAppDismiss = vi.fn(() => {
			expect(container.application.views).toHaveLength(0)
		})
		const container = createContainer({ mount, onAppDismiss })
		const app = await container.openApp({ appId: 'wx-desktop-dismiss', path: 'pages/index/index' })
		await container.application.dismissView(app, { destroy: true })
		expect(onAppDismiss).toHaveBeenCalledExactlyOnceWith('wx-desktop-dismiss')
		await container.application.dismissView(app)
		expect(onAppDismiss).toHaveBeenCalledOnce()
		mount.remove()
	}, 10000)

	it('lets a native host present and dismiss without container animation frames', async () => {
		const mount = document.createElement('div')
		const container = createContainer({ mount, appTransitions: false, urlSync: false })
		const view = createView()
		const frames = vi.spyOn(window, 'requestAnimationFrame')
		try {
			await container.application.presentView(view, false)
			expect(view.el.classList.contains('dimina-native-view--instage')).toBe(true)
			await container.application.dismissView(view)
			expect(frames).not.toHaveBeenCalled()
			expect(view.onPresentIn).toHaveBeenCalledOnce()
			expect(view.onPresentOut).toHaveBeenCalledOnce()
			expect(view.destroy).toHaveBeenCalledOnce()
		}
		finally { frames.mockRestore() }
	}, 10000)

	it('waits for the host to hide its window before removing the displayed content', async () => {
		const mount = document.createElement('div')
		document.body.appendChild(mount)
		let hidden!: () => void
		const hiddenAck = new Promise<void>(resolve => { hidden = resolve })
		const onAppWillDismiss = vi.fn(() => hiddenAck)
		const onAppDismiss = vi.fn()
		const container = createContainer({ mount, appTransitions: false, urlSync: false, onAppWillDismiss, onAppDismiss })
		const view = createView()
		await container.application.presentView(view, false)
		const closing = container.application.dismissView(view)
		try {
			await vi.waitFor(() => expect(onAppWillDismiss).toHaveBeenCalledExactlyOnceWith(view.appId))
			expect(view.el.isConnected).toBe(true)
			expect(view.el.classList.contains('dimina-native-view--instage')).toBe(true)
			expect(onAppDismiss).not.toHaveBeenCalled()
		}
		finally { hidden(); await closing; mount.remove() }
		expect(onAppDismiss).toHaveBeenCalledExactlyOnceWith(view.appId)
		await container.application.dismissView(view)
		expect(onAppWillDismiss).toHaveBeenCalledOnce()
	}, 10000)
})
