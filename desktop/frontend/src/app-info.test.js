import { afterEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
	const app = { whenReady: vi.fn().mockResolvedValue(), notifyViewportChange: vi.fn() }
	const container = { openApp: vi.fn().mockResolvedValue(app), registerApi: vi.fn(), application: { views: [app] }, closeApp: vi.fn() }
	return {
		createContainer: vi.fn(() => container),
		desktop: {
			bootstrap: vi.fn().mockResolvedValue({ app: { appId: 'wx-desktop-logo', name: '星河示例' }, baseUrl: 'http://127.0.0.1:9000/private/', resourceBaseUrl: 'http://127.0.0.1:9000/private/packages/' }),
			presentWindow: vi.fn().mockResolvedValue(),
			prepareToClose: vi.fn().mockResolvedValue(),
			runtimeReady: vi.fn().mockResolvedValue(),
		},
	}
})

vi.mock('@dimina/fe-container-sdk', () => ({ createContainer: mocks.createContainer }))
vi.mock('./native.js', () => ({ desktop: mocks.desktop, registerDesktopApis: vi.fn() }))

afterEach(() => vi.unstubAllGlobals())

it('provides the launch screen with the same generated logo as the application list', async () => {
	const logo = 'data:image/png;base64,ZGVza3RvcC1sb2dv'
	const context = { scale: vi.fn(), fillRect: vi.fn(), fillText: vi.fn(), measureText: () => ({ actualBoundingBoxAscent: 20, actualBoundingBoxDescent: 4 }) }
	let decoded
	const logoDecoded = new Promise(resolve => { decoded = resolve })
	const image = { decode: vi.fn(() => logoDecoded) }
	const root = { replaceChildren: vi.fn(), classList: { add: vi.fn() }, querySelectorAll: () => [image], getBoundingClientRect: vi.fn() }
	vi.stubGlobal('document', {
		getElementById: () => root,
		createElement: () => ({ style: {}, getContext: () => context, toDataURL: () => logo }),
		addEventListener: vi.fn(),
		fonts: { ready: Promise.resolve() },
	})
	vi.stubGlobal('window', { mygo: { on: vi.fn() }, addEventListener: vi.fn(), devicePixelRatio: 2 })
	vi.stubGlobal('location', { origin: 'http://127.0.0.1:9000' })
	vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
	const started = import('./index.js')
	await vi.waitFor(() => expect(image.decode).toHaveBeenCalledOnce())
	expect(mocks.desktop.presentWindow).not.toHaveBeenCalled()
	decoded()
	await started
	expect(root.getBoundingClientRect).toHaveBeenCalledOnce()
	const options = mocks.createContainer.mock.calls[0][0]
	expect(options.getAppInfo('wx-desktop-logo')).toMatchObject({ name: '星河示例', logo })
	expect(options.appTransitions).toBe(false)
	expect(mocks.desktop.presentWindow).toHaveBeenCalledOnce()
	await options.onAppWillDismiss('wx-desktop-logo')
	expect(mocks.desktop.prepareToClose).toHaveBeenCalledOnce()
})
