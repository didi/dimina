import type { MiniApp } from '../src/pages/miniApp/miniApp.js'
import { expect, it, vi } from 'vitest'
import { Application } from '../src/pages/application/application.js'

it('returns to the host root when the last mini program closes and can present it again', async () => {
	const application = new Application({ urlSync: false })
	const root = { el: document.createElement('div'), onPresentIn: vi.fn(), onPresentOut: vi.fn() }
	application.initRootView(root)
	const view = {
		appId: 'generated-root-return', el: document.createElement('div'),
		onPresentIn: vi.fn(), onPresentOut: vi.fn(), viewDidLoad: vi.fn(),
		restoreColorStyle: vi.fn(), getPageStack: () => [],
	} as unknown as MiniApp
	await application.presentView(view, false)
	await application.dismissView(view, { destroy: false })
	expect(root.onPresentIn).toHaveBeenCalledOnce()
	expect(root.onPresentOut).toHaveBeenCalledOnce()
	expect(root.el.parentElement).toBe(application.window)
	expect(root.el.classList.contains('dimina-native-view--presenting')).toBe(false)
	await application.presentView(view, true)
	expect(application.views).toEqual([view])
	expect(root.onPresentOut).toHaveBeenCalledTimes(2)
}, 10000)
