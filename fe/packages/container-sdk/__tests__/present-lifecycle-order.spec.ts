import type { Bridge } from '../src/core/bridge.js'
import { describe, expect, it, vi } from 'vitest'
import { MiniApp } from '../src/pages/miniApp/miniApp.js'

describe('MiniApp presentation lifecycle order', () => {
	it('hides the current page before hiding the app and shows the app before the page', () => {
		const calls: string[] = []
		const bridge = {
			pageHide: vi.fn(() => calls.push('pageHide')),
			pageShow: vi.fn(() => calls.push('pageShow')),
		} as unknown as Bridge
		const app = Object.create(MiniApp.prototype) as MiniApp
		Object.assign(app, {
			navigator: { top: bridge },
			webSocketManager: {
				onAppHide: vi.fn(),
				onAppShow: vi.fn(),
			},
			jscore: {
				appHide: vi.fn(() => calls.push('appHide')),
				appShow: vi.fn(() => calls.push('appShow')),
			},
		})

		app.onPresentOut()
		expect(calls).toEqual(['pageHide', 'appHide'])

		calls.length = 0
		app.onPresentIn()
		expect(calls).toEqual(['appShow', 'pageShow'])
	})
})
