import { afterEach, expect, it, vi } from 'vitest'
import { registerHostApis } from './native.js'

afterEach(() => vi.unstubAllGlobals())

it('registers only the API names explicitly provided by the host', () => {
	const registerApi = vi.fn()
	registerHostApis({ registerApi })
	expect(registerApi).not.toHaveBeenCalled()
	registerHostApis({ registerApi }, ['getNetworkType'])
	expect(registerApi.mock.calls.map(([name]) => name)).toEqual(['getNetworkType'])
})

it('exposes native names and preserves success/fail/complete callback semantics', async () => {
	const handlers = new Map()
	const invoke = vi.fn().mockResolvedValue({ networkType: 'wifi' })
	vi.stubGlobal('window', { mygo: { call: invoke } })
	registerHostApis({ registerApi: (name, handler) => handlers.set(name, handler) }, ['getNetworkType'])
	const success = vi.fn(), fail = vi.fn(), complete = vi.fn()
	const context = { createCallbackFunction: id => ({ s: success, f: fail, c: complete })[id] }
	handlers.get('getNetworkType').call(context, { input: 42, success: 's', fail: 'f', complete: 'c' })
	await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce())
	expect(invoke).toHaveBeenCalledWith('Desktop.InvokeHostApi', 'getNetworkType', { input: 42 })
	expect(success).toHaveBeenCalledWith({ networkType: 'wifi', errMsg: 'getNetworkType:ok' })
	expect(fail).not.toHaveBeenCalled()
	invoke.mockRejectedValueOnce(new Error('permission denied'))
	handlers.get('getNetworkType').call(context, { input: 3, success: 's', fail: 'f', complete: 'c' })
	await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(2))
	expect(invoke).toHaveBeenLastCalledWith('Desktop.InvokeHostApi', 'getNetworkType', { input: 3 })
	expect(fail).toHaveBeenCalledWith({ errMsg: 'getNetworkType:fail permission denied' })
	expect(success).toHaveBeenCalledOnce()
})

it.each(['scanCode:fail cancel', 'scanCode:invalid result'])('preserves the mobile SDK failure %s and sends the same object to complete', async (errMsg) => {
	const handlers = new Map()
	const result = { errMsg, errCode: 2001 }
	vi.stubGlobal('window', { mygo: { call: vi.fn().mockResolvedValue(result) } })
	registerHostApis({ registerApi: (name, handler) => handlers.set(name, handler) }, ['scanCode'])
	const success = vi.fn(), fail = vi.fn(), complete = vi.fn()
	handlers.get('scanCode').call({ createCallbackFunction: id => ({ s: success, f: fail, c: complete })[id] }, { success: 's', fail: 'f', complete: 'c' })
	await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce())
	expect(success).not.toHaveBeenCalled()
	expect(fail).toHaveBeenCalledWith(result)
	expect(complete.mock.calls[0][0]).toBe(fail.mock.calls[0][0])
})

it('keeps native event subscriptions persistent and does not invoke them when registered', async () => {
	const { registerDesktopApis, dispatchRuntimeEvent } = await import('./native.js')
	const handlers = new Map(), callback = vi.fn()
	const call = vi.fn().mockResolvedValue(null)
	vi.stubGlobal('window', { mygo: { call } })
	registerDesktopApis({ registerApi: (name, handler) => handlers.set(name, handler) }, ['onBluetoothDeviceFound'])
	const app = { createCallbackFunction: () => callback }
	handlers.get('onBluetoothDeviceFound').call(app, { callbackId: 'listener', success: 'listener', keep: true })
	await Promise.resolve()
	expect(callback).not.toHaveBeenCalled()
	dispatchRuntimeEvent(app, { callbackId: 'listener', value: { devices: [1] } })
	dispatchRuntimeEvent(app, { callbackId: 'listener', value: { devices: [2] } })
	expect(callback.mock.calls).toEqual([[{ devices: [1] }], [{ devices: [2] }]])
})

it('returns request binary bytes in the mobile JSON transport format to success and complete', async () => {
	const { registerDesktopApis } = await import('./native.js')
	const handlers = new Map(), results = {}
	vi.stubGlobal('window', { mygo: { call: vi.fn().mockResolvedValue({ statusCode: 200, header: {}, base64: 'AP8BgAA=' }) } })
	registerDesktopApis({ registerApi: (name, handler) => handlers.set(name, handler) })
	handlers.get('request').call({ createCallbackFunction: id => id && (value => { results[id] = JSON.parse(JSON.stringify(value)) }) }, { responseType: 'arraybuffer', success: 'success', complete: 'complete' })
	await vi.waitFor(() => expect(results.complete).toBeDefined())
	for (const result of [results.success, results.complete]) {
		expect(result.data).toEqual({ __diminaArrayBufferBase64: 'AP8BgAA=' })
		expect(result.errMsg).toBe('request:ok')
	}
})
