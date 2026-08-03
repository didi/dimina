import { beforeEach, describe, expect, it } from 'vitest'
import { createContainer } from '../src/index.js'
import { resetFakeWorker } from './fixtures/fake-worker.js'
import { installFetchMock } from './fixtures/mock-fetch.js'

// 契约（红灯阶段，allowedOrigins 尚未实现，resourceBaseUrl/pageFrameUrl 目前也还是裸字符串
// 拼接，不是真实 URL 解析——见 src/config.ts 的 resolveResourceBaseUrl/resolvePageFrameUrl）：
//
// 1. resourceBaseUrl/pageFrameUrl 改走真实 `new URL(value, window.location.origin)` 解析：
//    - 相对路径按 window.location.origin 解析成绝对 URL；已是绝对 URL 的输入原样保留（只是
//      过一遍 URL 规范化）。
//    - resourceBaseUrl 解析结果必须始终以 '/' 结尾。
//    - pageFrameUrl 缺省时基于已解析的 resourceBaseUrl 用 `new URL('pageFrame.html', resourceBaseUrl)`
//      算出。
//    - 无法解析的畸形 URL 字符串必须让 createContainer() 明确抛错。
// 2. allowedOrigins 不传：完全向后兼容，不做来源限制，跨域 CDN 场景必须继续正常工作。
// 3. allowedOrigins 传了：createContainer() 必须在返回之前**同步**抛出 Error，如果最终解析出的
//    resourceBaseUrl 或 pageFrameUrl 的 origin 不在名单里（origin 精确匹配）；命中名单则正常返回，
//    不影响后续 openApp() 等行为。默认值（不传 resourceBaseUrl/pageFrameUrl）也受这个约束——不是例外。
//
// Application 实例上的 resourceBaseUrl/pageFrameUrl 是公开字段（src/pages/application/application.ts），
// createContainer() 返回的 container.application 就是这个实例，可以直接同步读出解析结果做强断言，
// 不需要像 __tests__/resource-base-url.spec.ts 那样绕道 fetch 调用前缀。
//
// allowedOrigins 目前还不在 CreateContainerOptions 类型上，直接写
// `createContainer({ mount, allowedOrigins })` 字面量会撞 TS 的"多余属性检查"报错。这里跟
// __tests__/on-app-launch-error.spec.ts 一样，用一个局部 interface 声明的变量（非字面量）
// 传参绕开检查；等实现把 allowedOrigins 补进 CreateContainerOptions 后，这个局部 interface
// 与真实类型结构一致，调用点不需要任何回改。

interface CreateContainerOptionsWithAllowedOrigins {
	mount: HTMLElement
	resourceBaseUrl?: string
	pageFrameUrl?: string
	allowedOrigins?: readonly string[]
}

function createContainerWithOptions(options: CreateContainerOptionsWithAllowedOrigins) {
	return createContainer(options)
}

describe('createContainer resourceBaseUrl/pageFrameUrl real URL resolution', () => {
	let mount: HTMLElement

	beforeEach(() => {
		resetFakeWorker()
		installFetchMock()
		mount = document.createElement('div')
		document.body.appendChild(mount)
	})

	it('defaults resourceBaseUrl to window.location.origin + "/" (not the bare string "/")', () => {
		const container = createContainer({ mount })

		expect(container.application.resourceBaseUrl).toBe(`${window.location.origin}/`)
	})

	it('resolves a relative resourceBaseUrl against window.location.origin and keeps a trailing slash', () => {
		const container = createContainer({ mount, resourceBaseUrl: '/static/miniapp' })

		expect(container.application.resourceBaseUrl).toBe(`${window.location.origin}/static/miniapp/`)
	})

	it('passes an already-absolute cross-origin resourceBaseUrl through unchanged', () => {
		const container = createContainer({ mount, resourceBaseUrl: 'https://cdn.example.com/miniapp/' })

		expect(container.application.resourceBaseUrl).toBe('https://cdn.example.com/miniapp/')
	})

	it('derives the default pageFrameUrl from the resolved (same-origin) resourceBaseUrl', () => {
		const container = createContainer({ mount, resourceBaseUrl: '/static/miniapp' })

		expect(container.application.pageFrameUrl).toBe(`${window.location.origin}/static/miniapp/pageFrame.html`)
	})

	it('derives the default pageFrameUrl from the resolved cross-origin resourceBaseUrl', () => {
		const container = createContainer({ mount, resourceBaseUrl: 'https://cdn.example.com/miniapp/' })

		expect(container.application.pageFrameUrl).toBe('https://cdn.example.com/miniapp/pageFrame.html')
	})

	it('throws synchronously when resourceBaseUrl cannot be parsed as a URL', () => {
		expect(() => createContainer({ mount, resourceBaseUrl: 'http://[' })).toThrow()
	})

	it('throws synchronously when pageFrameUrl cannot be parsed as a URL', () => {
		expect(() => createContainer({ mount, resourceBaseUrl: '/static/miniapp/', pageFrameUrl: 'http://[' })).toThrow()
	})
})

describe('createContainer allowedOrigins omitted — fully backward compatible', () => {
	let mount: HTMLElement

	beforeEach(() => {
		resetFakeWorker()
		installFetchMock()
		mount = document.createElement('div')
		document.body.appendChild(mount)
	})

	it('keeps working normally for a cross-origin CDN resourceBaseUrl with no origin restriction', async () => {
		const container = createContainer({ mount, resourceBaseUrl: 'https://cdn.example.com/miniapp/' })

		expect(container.application.resourceBaseUrl).toBe('https://cdn.example.com/miniapp/')
		expect(container.application.pageFrameUrl).toBe('https://cdn.example.com/miniapp/pageFrame.html')

		const miniApp = await container.openApp({ appId: 'wx-cross-origin-no-restriction', path: 'pages/index/index' })
		expect(miniApp).toBeTruthy()
	}, 10000)
})

describe('createContainer allowedOrigins provided — origin allow-list enforcement', () => {
	let mount: HTMLElement

	beforeEach(() => {
		resetFakeWorker()
		installFetchMock()
		mount = document.createElement('div')
		document.body.appendChild(mount)
	})

	it('returns a working instance when both resolved origins are allow-listed', async () => {
		const container = createContainerWithOptions({
			mount,
			resourceBaseUrl: 'https://cdn.example.com/miniapp/',
			allowedOrigins: ['https://cdn.example.com', window.location.origin],
		})

		expect(container.application.resourceBaseUrl).toBe('https://cdn.example.com/miniapp/')

		const miniApp = await container.openApp({ appId: 'wx-allowed-origin-hit', path: 'pages/index/index' })
		expect(miniApp).toBeTruthy()
	}, 10000)

	it('throws synchronously when the resolved resourceBaseUrl origin is not in allowedOrigins', () => {
		let caught: unknown

		try {
			createContainerWithOptions({
				mount,
				resourceBaseUrl: 'https://cdn.example.com/miniapp/',
				allowedOrigins: ['https://trusted.example.com'],
			})
		}
		catch (error) {
			caught = error
		}

		expect(caught).toBeInstanceOf(Error)
		expect((caught as Error).message).toContain('https://cdn.example.com')
	})

	it('throws synchronously when an explicit pageFrameUrl origin is not in allowedOrigins even if resourceBaseUrl is', () => {
		let caught: unknown

		try {
			createContainerWithOptions({
				mount,
				resourceBaseUrl: 'https://trusted.example.com/miniapp/',
				pageFrameUrl: 'https://renderer.example.com/pageFrame.html',
				allowedOrigins: ['https://trusted.example.com'],
			})
		}
		catch (error) {
			caught = error
		}

		expect(caught).toBeInstanceOf(Error)
		expect((caught as Error).message).toContain('https://renderer.example.com')
	})

	it('rejects the default resourceBaseUrl too — defaults are not exempt from allowedOrigins', () => {
		// 不传 resourceBaseUrl，缺省解析为 window.location.origin；allowedOrigins 显式排除了
		// 这个 origin，createContainer() 必须照样抛错，不能因为"是缺省值"就放行。
		let caught: unknown

		try {
			createContainerWithOptions({
				mount,
				allowedOrigins: ['https://cdn.example.com'],
			})
		}
		catch (error) {
			caught = error
		}

		expect(caught).toBeInstanceOf(Error)
		expect((caught as Error).message).toContain(window.location.origin)
	})

	it('does not throw when allowedOrigins exactly matches the default (same-origin) resolution', () => {
		const container = createContainerWithOptions({
			mount,
			allowedOrigins: [window.location.origin],
		})

		expect(container.application.resourceBaseUrl).toBe(`${window.location.origin}/`)
		expect(container.application.pageFrameUrl).toBe(`${window.location.origin}/pageFrame.html`)
	})
})
