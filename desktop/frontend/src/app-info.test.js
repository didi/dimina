import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
	const app = { whenReady: vi.fn().mockResolvedValue(), notifyViewportChange: vi.fn() }
	const container = { openApp: vi.fn().mockResolvedValue(app), registerApi: vi.fn(), application: { views: [app] }, closeApp: vi.fn() }
	return {
		container,
		app,
		createContainer: vi.fn(() => container),
		desktop: {
			bootstrap: vi.fn().mockResolvedValue({ app: { appId: 'wx-desktop-logo', name: '星河示例' }, baseUrl: 'http://127.0.0.1:9000/private/', resourceBaseUrl: 'http://127.0.0.1:9000/private/packages/' }),
			presentWindow: vi.fn().mockResolvedValue(),
			prepareToClose: vi.fn().mockResolvedValue(),
			runtimeReady: vi.fn().mockResolvedValue(),
			runtimeFailed: vi.fn().mockResolvedValue(),
		},
	}
})

vi.mock('@dimina/fe-container-sdk', () => ({ createContainer: mocks.createContainer }))
vi.mock('./native.js', () => ({ desktop: mocks.desktop, registerDesktopApis: vi.fn(), registerHostApis: vi.fn() }))

beforeEach(() => {
	vi.resetModules()
	vi.clearAllMocks()
	mocks.container.application.views = [mocks.app]
	mocks.app.whenReady.mockResolvedValue()
})
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
	const close = window.mygo.on.mock.calls.find(([name]) => name === 'desktop:close')[1]
	close()
	expect(mocks.container.closeApp).toHaveBeenCalledOnce()
})

it('reports failed startup to the caller and can close the resulting error window', async () => {
	const error = new Error('render resource load failed')
	mocks.app.whenReady.mockRejectedValueOnce(error)
	const status = { setAttribute: vi.fn() }
	const context = { scale: vi.fn(), fillRect: vi.fn(), fillText: vi.fn(), measureText: () => ({ actualBoundingBoxAscent: 20, actualBoundingBoxDescent: 4 }) }
	const root = { replaceChildren: vi.fn(), classList: { add: vi.fn() }, querySelectorAll: () => [], getBoundingClientRect: vi.fn() }
	vi.stubGlobal('document', {
		getElementById: id => id === 'root' ? root : status,
		createElement: () => ({ style: {}, getContext: () => context, toDataURL: () => 'data:image/png;base64,bG9nbw==' }),
		addEventListener: vi.fn(),
		fonts: { ready: Promise.resolve() },
	})
	vi.stubGlobal('window', { mygo: { on: vi.fn(), window: { close: vi.fn() } }, addEventListener: vi.fn() })
	vi.stubGlobal('location', { origin: 'http://127.0.0.1:9000' })
	const log = vi.spyOn(console, 'error').mockImplementation(() => {})
	try {
		await import('./index.js')
		expect(mocks.desktop.runtimeFailed).toHaveBeenCalledWith(error.message)
		expect(mocks.desktop.runtimeReady).not.toHaveBeenCalled()
		mocks.container.application.views = []
		const close = window.mygo.on.mock.calls.find(([name]) => name === 'desktop:close')[1]
		close()
		expect(window.mygo.window.close).toHaveBeenCalledOnce()
		expect(mocks.container.closeApp).not.toHaveBeenCalled()
	} finally { log.mockRestore() }
})
