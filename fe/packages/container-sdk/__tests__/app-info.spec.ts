import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createContainer } from '../src/index.js'
import { installFetchMock } from './fixtures/mock-fetch.js'

// 契约行为 6：getAppInfo(appId) 注入生效，openApp 用它取代 demo 里
// "fetch appList.json + 猜 name/logo" 的那一套；不提供时不发任何 appList.json 请求，
// 且没有 name/logo 也必须能正常打开小程序。
describe('createContainer getAppInfo passthrough', () => {
	let mount: HTMLElement

	beforeEach(() => {
		mount = document.createElement('div')
		document.body.appendChild(mount)
	})

	it('does not request appList.json when getAppInfo is not provided', async () => {
		const { calls } = installFetchMock()
		const container = createContainer({ mount })

		const miniApp = await container.openApp({ appId: 'wx-no-getappinfo', path: 'pages/index/index' })

		expect(miniApp).toBeTruthy()
		// 给后台链路一点时间，确认真的没有请求 appList.json，而不是还没来得及请求。
		await new Promise(resolve => setTimeout(resolve, 50))
		expect(calls.some(url => url.includes('appList.json'))).toBe(false)
	}, 10000)

	it('calls the injected getAppInfo with the opened appId', async () => {
		installFetchMock()
		const getAppInfo = vi.fn(async () => ({ name: 'Injected App', logo: 'data:image/png;base64,injected' }))
		const container = createContainer({ mount, getAppInfo })

		await container.openApp({ appId: 'wx-with-getappinfo', path: 'pages/index/index' })

		await vi.waitFor(() => {
			expect(getAppInfo).toHaveBeenCalledWith('wx-with-getappinfo')
		}, { timeout: 8000 })
	}, 10000)

	it('still opens the app when getAppInfo is not provided (defaults to {})', async () => {
		installFetchMock()
		const container = createContainer({ mount })

		const miniApp = await container.openApp({ appId: 'wx-default-info', path: 'pages/index/index' })

		expect(miniApp).toBeTruthy()
	}, 10000)
})
