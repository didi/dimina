import { afterEach, describe, expect, it, vi } from 'vitest'
import { createContainer } from '../src/index.js'
import { MiniApp } from '../src/pages/miniApp/miniApp.js'
import { installFetchMock } from './fixtures/mock-fetch.js'

afterEach(() => vi.unstubAllGlobals())

function animatedLaunchScreen() {
	const app = Object.create(MiniApp.prototype) as MiniApp
	app.el = document.createElement('div')
	app.el.innerHTML = '<div class="dimina-mini-app__launch-screen" style="display:block;--dimina-launch-screen-fade-ms:150ms"><span class="dimina-mini-app__name"></span><img class="dimina-mini-app__logo-img-url"></div>'
	app.appInfo = { name: 'Demo', logo: 'data:image/png;base64,AA==' } as MiniApp['appInfo']
	app.updateActionColorStyle = vi.fn()
	const screen = app.el.firstElementChild as HTMLElement
	let finish!: () => void
	const animation = { finished: new Promise<void>(resolve => { finish = resolve }), cancel: vi.fn() }
	screen.animate = vi.fn(() => animation as unknown as Animation)
	return { app, screen, animation, finish }
}

describe('launch screen presentation', () => {
	it('makes the first DOM ready without the mobile animation delay when app transitions are disabled', async () => {
		vi.useFakeTimers()
		installFetchMock()
		const mount = document.createElement('div')
		document.body.appendChild(mount)
		const container = createContainer({ mount, appTransitions: false, urlSync: false })
		const app = await container.openApp({ appId: 'wx-desktop-fast-start', path: 'pages/index/index' })
		const ready = vi.fn()
		void app.whenReady().then(ready)
		try {
			await vi.advanceTimersByTimeAsync(1)
			expect(ready).toHaveBeenCalledOnce()
		}
		finally {
			app.destroy()
			await vi.advanceTimersByTimeAsync(600)
			vi.useRealTimers()
		}
	})

	it('reveals the ready page immediately for input and fades the loading overlay before removing it', async () => {
		const { app, screen, animation, finish } = animatedLaunchScreen()
		app.hideLaunchScreen()
		expect(screen.style.display).toBe('block')
		expect(screen.style.pointerEvents).toBe('none')
		expect(screen.animate).toHaveBeenCalledWith([{ opacity: 1 }, { opacity: 0 }], expect.objectContaining({ duration: 150 }))
		finish()
		await animation.finished
		expect(screen.style.display).toBe('none')
	})

	it('keeps a restarted loading screen visible when the previous fade finishes late', async () => {
		const { app, screen, animation, finish } = animatedLaunchScreen()
		app.hideLaunchScreen()
		app.showLaunchScreen()
		expect(animation.cancel).toHaveBeenCalledOnce()
		finish()
		await animation.finished
		expect(screen.style.display).toBe('block')
		expect(screen.style.pointerEvents).toBe('')
	})

	it('uses a gentler fade when reduced motion is requested', () => {
		vi.stubGlobal('matchMedia', () => ({ matches: true }))
		const { app, screen } = animatedLaunchScreen()
		app.hideLaunchScreen()
		expect(screen.animate).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ duration: 100 }))
	})
})
