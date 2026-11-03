import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => vi.useRealTimers())

it('hides before suspension, defers API callbacks, and keeps exit callbacks and barriers live', async () => {
	vi.resetModules()
	vi.useFakeTimers()
	globalThis.DiminaServiceBridge.invoke = vi.fn()
	const service = (await import('../src/index')).default
	const { callback } = await import('@dimina/common')
	const { invokeAPI } = await import('../src/api/common')
	const runtime = (await import('../src/core/runtime')).default
	const events = []
	runtime.app = { appHide: () => events.push('hide'), appShow: () => events.push('show') }
	const normalId = callback.store(() => events.push('network'))
	invokeAPI('exitMiniProgram', { success: () => events.push('exit'), complete: () => events.push('complete') })
	const params = globalThis.DiminaServiceBridge.invoke.mock.calls.at(-1)[0].body.params
	globalThis.setTimeout(() => events.push('timer'), 10)
	service.message.handleMsg({ type: 'appHide' })
	service.message.handleMsg({ type: 'triggerCallback', body: { id: normalId } })
	service.message.handleMsg({ type: 'triggerCallback', body: { id: params.success } })
	service.message.handleMsg({ type: 'triggerCallback', body: { id: params.complete } })
	service.message.handleMsg({ type: 'flushCallbacks', body: { requestId: 'exit-barrier' } })
	vi.advanceTimersByTime(1000)
	expect(events).toEqual(['hide', 'exit', 'complete'])
	expect(globalThis.DiminaServiceBridge.invoke).toHaveBeenLastCalledWith({
		type: 'callbacksFlushed', target: 'container', body: { requestId: 'exit-barrier' },
	})
	service.message.handleMsg({ type: 'appShow', body: {} })
	vi.advanceTimersByTime(10)
	expect(events).toEqual(['hide', 'exit', 'complete', 'show', 'network', 'timer'])
})


it('preserves business state derived by Promise callbacks before the API complete callback', async () => {
	vi.resetModules()
	vi.useFakeTimers()
	globalThis.DiminaServiceBridge.invoke = vi.fn()
	const service = (await import('../src/index')).default
	globalThis.App({
		globalData: { phase: 'initial', completedPhase: undefined },
		onHide() { this.globalData.hidden = true },
		onShow() { this.globalData.hidden = false },
	})
	const app = globalThis.getApp()
	globalThis.wx.getStorageInfo({
		success() {
			Promise.resolve().then(() => { app.globalData.phase = 'decoded' })
				.then(() => { app.globalData.phase = 'ready' })
		},
		complete() { app.globalData.completedPhase = app.globalData.phase },
	})
	const params = globalThis.DiminaServiceBridge.invoke.mock.calls.at(-1)[0].body.params
	service.message.handleMsg({ type: 'appHide' })
	service.message.handleMsg({ type: 'triggerCallback', body: { id: params.success, args: { keys: [] } } })
	service.message.handleMsg({ type: 'triggerCallback', body: { id: params.complete } })
	await vi.runAllTimersAsync()
	expect(app.globalData.phase).toBe('initial')
	expect(app.globalData.hidden).toBe(true)
	service.message.handleMsg({ type: 'appShow', body: {} })
	await vi.runAllTimersAsync()
	expect(app.globalData.hidden).toBe(false)
	expect(app.globalData.completedPhase).toBe('ready')
})

it('applies topology before mount acknowledgements while business work is suspended', async () => {
	vi.resetModules()
	vi.useFakeTimers()
	const service = (await import('../src/index')).default
	const runtime = (await import('../src/core/runtime')).default
	const order = []
	runtime.app = { appHide() {}, appShow() {} }
	vi.spyOn(runtime, 'moduleTreeUpdated').mockImplementation(() => order.push('tree'))
	vi.spyOn(runtime, 'moduleAttached').mockImplementation(() => order.push('attached'))
	vi.spyOn(runtime, 'moduleReady').mockImplementation(() => order.push('ready'))

	service.message.handleMsg({ type: 'appHide', body: {} })
	for (const type of ['mT', 'mA', 'mR']) service.message.handleMsg({ type, body: {} })
	expect(order).toEqual(['tree', 'attached', 'ready'])
})
