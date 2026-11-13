import { afterEach, expect, it, vi } from 'vitest'
import { registerDesktopApis, registerHostApis } from './native.js'

afterEach(() => vi.unstubAllGlobals())

it('restores the built-in desktop API after the host removes an app grant', async () => {
	const handlers = new Map(), success = vi.fn(), fail = vi.fn(), complete = vi.fn()
	const call = vi.fn((binding) => binding === 'Desktop.InvokeHostApi' ? Promise.reject(new Error('API is not granted to this mini program')) : Promise.resolve({ networkType: 'unknown' }))
	vi.stubGlobal('window', { mygo: { call } })
	const container = { registerApi: (name, handler) => handlers.set(name, handler) }
	registerDesktopApis(container, ['getNetworkType'])
	registerHostApis(container, ['getNetworkType'])
	registerHostApis(container, [])
	handlers.get('getNetworkType').call({ createCallbackFunction: id => ({ s: success, f: fail, c: complete })[id] }, { success: 's', fail: 'f', complete: 'c' })
	await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce())
	expect(fail).not.toHaveBeenCalled()
	expect(success).toHaveBeenCalledWith({ networkType: 'unknown', errMsg: 'getNetworkType:ok' })
	expect(call).toHaveBeenCalledWith('Desktop.Invoke', 'getNetworkType', {})
})

it('restores the existing Web container method when a host-only override is removed', () => {
	const handlers = new Map(), original = vi.fn()
	const container = { registerApi: (name, handler) => handlers.set(name, handler) }
	registerHostApis(container, ['getSetting'])
	registerHostApis(container, [])
	vi.stubGlobal('window', { mygo: { call: vi.fn().mockResolvedValue({}) } })
	const app = { getSetting: original, createCallbackFunction: () => undefined }
	handlers.get('getSetting').call(app, { success: 'callback' })
	expect(original).toHaveBeenCalledWith({ success: 'callback' })
	expect(original.mock.instances[0]).toBe(app)
})
