import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createContainer } from '../src/index.js'
import { FakeWorker, resetFakeWorker } from './fixtures/fake-worker.js'
import { installFetchMock } from './fixtures/mock-fetch.js'

// 契约行为 3：resourceBaseUrl 要贯通到（a）读取小程序配置的请求 URL 前缀，
// （b）bridge 下发给逻辑线程的 baseUrl。逻辑线程通道用 FakeWorker 捕获
// postMessage 载荷来验证；渲染线程走 iframe，__tests__/setup.js 里已经给
// DiminaRenderBridge 打了通用桩，帮启动链路跑过 webview 握手。
describe('createContainer resourceBaseUrl passthrough', () => {
	let mount: HTMLElement
	const RESOURCE_BASE_URL = '/custom-resource-base/'

	beforeEach(() => {
		resetFakeWorker()
		mount = document.createElement('div')
		document.body.appendChild(mount)
	})

	it('prefixes the app config request with resourceBaseUrl', async () => {
		const { calls } = installFetchMock()
		const container = createContainer({ mount, resourceBaseUrl: RESOURCE_BASE_URL })

		await container.openApp({ appId: 'wx-base', path: 'pages/index/index' })

		// resourceBaseUrl 现在经真实 URL 解析（allowedOrigins 契约的一部分），一个相对路径
		// 输入会归一化成挂在 window.location.origin 下的绝对 URL，不再是裸相对路径本身。
		await vi.waitFor(() => {
			expect(calls.some(url => url.startsWith(`${window.location.origin}${RESOURCE_BASE_URL}`))).toBe(true)
		}, { timeout: 8000 })
	}, 10000)

	it('forwards resourceBaseUrl as baseUrl to the logic thread', async () => {
		installFetchMock()
		const container = createContainer({ mount, resourceBaseUrl: RESOURCE_BASE_URL })

		await container.openApp({ appId: 'wx-base-2', path: 'pages/index/index' })

		await vi.waitFor(() => {
			const sawBaseUrl = FakeWorker.instances.some(worker =>
				worker.postMessage.mock.calls.some(([message]: [unknown]) =>
					JSON.stringify(message).includes(RESOURCE_BASE_URL)))
			expect(sawBaseUrl).toBe(true)
		}, { timeout: 8000 })
	}, 10000)

	it('defaults resourceBaseUrl to "/" when not provided', async () => {
		const { calls } = installFetchMock()
		const container = createContainer({ mount })

		await container.openApp({ appId: 'wx-base-default', path: 'pages/index/index' })

		await vi.waitFor(() => {
			expect(calls.length).toBeGreaterThan(0)
		}, { timeout: 8000 })
		// 缺省应落在 window.location.origin 根路径下（resourceBaseUrl 现在经真实 URL 解析，
		// 缺省值归一化为 `${origin}/`，不再是裸字符串 '/'），且不出现未定义前缀（如 "undefined..."）。
		expect(calls.every(url => url.startsWith(window.location.origin))).toBe(true)
	}, 10000)
})
