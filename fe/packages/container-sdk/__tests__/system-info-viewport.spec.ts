import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createContainer } from '../src/index.js'
import { installFetchMock } from './fixtures/mock-fetch.js'

describe('system info viewport coordinates', () => {
	let mount: HTMLElement

	beforeEach(() => {
		installFetchMock()
		mount = document.createElement('div')
		document.body.appendChild(mount)
	})

	it('uses the logical viewport size instead of its transformed visual bounds', async () => {
		const container = createContainer({ mount })
		const miniApp = await container.openApp({ appId: 'wx-logical-viewport', path: 'pages/index/index' })
		const viewport = mount.querySelector<HTMLElement>('.dimina-native-webview__root')!

		Object.defineProperties(viewport, {
			clientWidth: { configurable: true, value: 409 },
			clientHeight: { configurable: true, value: 865 },
		})
		viewport.getBoundingClientRect = () => ({
			x: 0,
			y: 0,
			top: 0,
			left: 0,
			right: 319,
			bottom: 674,
			width: 319,
			height: 674,
			toJSON: () => ({}),
		})

		const systemInfo = miniApp.getSystemInfoSync()

		expect(systemInfo.windowWidth).toBe(409)
		expect(systemInfo.windowHeight).toBe(865)
		expect(systemInfo.screenWidth).toBe(409)
		expect(systemInfo.screenHeight).toBe(865)
		expect(systemInfo.safeArea).toMatchObject({ right: 409, bottom: 865, width: 409 })
	}, 10000)

	it('preserves desktop identity and updates the snapshot before notifying every live page', async () => {
		const container = createContainer({ mount, hostSystemInfo: { platform: 'mac', system: 'darwin', version: '0.1.0' } })
		const miniApp = await container.openApp({ appId: 'wx-desktop-viewport', path: 'pages/index/index' })
		const viewport = mount.querySelector<HTMLElement>('.dimina-native-webview__root')!
		Object.defineProperties(viewport, { clientWidth: { configurable: true, value: 900 }, clientHeight: { configurable: true, value: 700 } })
		const post = vi.spyOn(miniApp.jscore, 'postMessage')
		miniApp.notifyViewportChange()
		expect(post.mock.calls[0][0]).toMatchObject({ type: 'hostEnvUpdate', body: { systemInfo: { platform: 'mac', version: '0.1.0', windowWidth: 900, windowHeight: 700, deviceOrientation: 'landscape' } } })
		expect(post.mock.calls[1][0]).toMatchObject({ type: 'pageResize', body: { bridgeId: miniApp.navigator.top!.id, size: { size: { windowWidth: 900, windowHeight: 700 }, deviceOrientation: 'landscape' } } })
		miniApp.destroy()
	}, 10000)
})
