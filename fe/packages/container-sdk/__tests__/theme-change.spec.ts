import { describe, expect, it, vi } from 'vitest'
import { MiniApp } from '../src/pages/miniApp/miniApp.js'

describe('MiniApp theme changes', () => {
	it('forwards host color-scheme changes to the service environment', () => {
		const listenerApi = vi.fn()
		const mediaQuery = {
			addEventListener: listenerApi,
			matches: false,
		}
		const originalMatchMedia = globalThis.matchMedia
		globalThis.matchMedia = vi.fn(() => mediaQuery) as unknown as typeof globalThis.matchMedia
		const app = Object.create(MiniApp.prototype) as MiniApp
		app.jscore = { postMessage: vi.fn() } as unknown as MiniApp['jscore']
		app.getSystemInfoSync = vi.fn(() => ({ theme: 'light', windowWidth: 375 })) as unknown as MiniApp['getSystemInfoSync']

		try {
			app._bindThemeChange()
			const handler = listenerApi.mock.calls[0][1] as (event: { matches: boolean }) => void
			handler({ matches: true })

			expect(app.jscore.postMessage).toHaveBeenCalledWith({
				type: 'hostEnvUpdate',
				body: {
					systemInfo: { theme: 'dark', windowWidth: 375 },
				},
			})
		}
		finally {
			globalThis.matchMedia = originalMatchMedia
		}
	})
})
