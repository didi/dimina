import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createContainer } from '../src/index.js'
import { installFetchMock } from './fixtures/mock-fetch.js'

// 回归测试：pageFrameUrl 带 query 时不能被裸拼成畸形 URL。
//
// 契约：pageFrameUrl 缺省是 `${resourceBaseUrl}pageFrame.html`；宿主如果自己传了
// 一个带 query 的 pageFrameUrl（比如接入方自己的渲染层入口需要携带参数），SDK 往
// 上追加自己的参数（如 dev 模式的 vconsole）时必须用 '&' 而不是重新拼一个 '?'。
// 抓的 bug：字符串裸拼 `${pageFrameUrl}?vconsole=1` 产出 '.../pageFrame.html?foo=1?vconsole=1'
// 这种整个 URL 出现两个 '?' 的畸形地址，第二个 '?' 及其后内容会被当成第一个
// query 参数值的一部分，宿主原本的 query 语义被破坏。
describe('pageFrameUrl preserves host query params', () => {
	let mount: HTMLElement

	beforeEach(() => {
		installFetchMock()
		mount = document.createElement('div')
		document.body.appendChild(mount)
	})

	it('keeps the host query param and produces a URL with a single "?"', async () => {
		const container = createContainer({ mount, pageFrameUrl: '/pageFrame.html?foo=1' })

		await container.openApp({ appId: 'wx-pageframe-query', path: 'pages/index/index' })

		let iframe: HTMLIFrameElement | null = null
		await vi.waitFor(() => {
			iframe = mount.querySelector('iframe')
			expect(iframe).toBeTruthy()
		}, { timeout: 8000 })

		const src = iframe!.getAttribute('src') ?? ''

		// 只能有一个 '?'：第一个分隔路径和 query，后面追加的参数只能用 '&'。
		expect((src.match(/\?/g) ?? []).length).toBe(1)

		// 宿主自己的 foo=1 必须还在，且能被当成一个独立的 query 参数正确解析出来
		// （不是被拼进另一个参数的值里）。
		const queryString = src.slice(src.indexOf('?') + 1)
		const params = new URLSearchParams(queryString)
		expect(params.get('foo')).toBe('1')
	}, 10000)
})
