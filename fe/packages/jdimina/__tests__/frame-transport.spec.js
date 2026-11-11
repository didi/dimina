import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFrameTransport } from '../src/frame-transport.js'

function guest(native = false) {
	const win = {
		parent: { postMessage: vi.fn() },
		addEventListener: vi.fn(), dispatchEvent: vi.fn(), Event,
		...(native ? { DiminaRenderBridge: { invoke: vi.fn() } } : {}),
	}
	win.receive = (data, source = win.parent, origin = 'https://host.example') => {
		win.addEventListener.mock.calls.find(([type]) => type === 'message')[1]({ source, origin, data })
	}
	return win
}

afterEach(() => vi.unstubAllGlobals())

describe('embedded H5 SDK transport', () => {
	it('keeps a top-level native page on its existing bridge', async () => {
		const win = guest(true)
		win.parent = win
		expect(createFrameTransport(win, vi.fn())).toBeNull()
		vi.stubGlobal('window', win)
		vi.resetModules()
		await import('../src/index.js')
		win.wx.miniProgram.getEnv(vi.fn())
		expect(win.DiminaRenderBridge.invoke).toHaveBeenCalledWith(expect.objectContaining({ type: 'invokeAPI' }))
		expect(win.addEventListener).not.toHaveBeenCalled()
	})

	it('uses the frame transport even when a native host exposes a proxy in the child frame', async () => {
		const win = guest(true)
		vi.stubGlobal('window', win)
		vi.resetModules()
		await import('../src/index.js')
		win.wx.miniProgram.postMessage({ data: { saved: true } })
		expect(win.DiminaRenderBridge.invoke).not.toHaveBeenCalled()
		const envelope = win.parent.postMessage.mock.calls.at(-1)[0]
		expect(envelope.request.body.name).toBe('h5postMessage')
		expect(envelope.request.body.params.data.params.data).toEqual({ saved: true })
	})

	it('round trips getEnv once and ignores foreign windows and sessions', async () => {
		const win = guest()
		vi.stubGlobal('window', win)
		vi.resetModules()
		await import('../src/index.js')
		const callback = vi.fn()
		win.wx.miniProgram.getEnv(callback)
		const { channel, session, request } = win.parent.postMessage.mock.calls.at(-1)[0]
		const response = { channel, session, kind: 'callback', id: request.body.params.success, args: { data: { miniprogram: true } } }
		win.receive(response, {})
		win.receive({ ...response, session: 'other-document' })
		expect(callback).not.toHaveBeenCalled()
		win.receive(response)
		win.receive(response)
		expect(callback).toHaveBeenCalledExactlyOnceWith({ miniprogram: true })
	})

	it('pins the parent origin after ready and announces readiness', () => {
		const win = guest()
		const callback = vi.fn()
		const transport = createFrameTransport(win, callback)
		const hello = win.parent.postMessage.mock.calls[0][0]
		win.receive({ ...hello, kind: 'ready' })
		expect(win.__wxjs_environment).toBe('miniprogram')
		expect(win.dispatchEvent.mock.calls[0][0].type).toBe('didiJsBridgeLoaded')
		transport.invoke({ type: 'test' })
		expect(win.parent.postMessage.mock.calls.at(-1)[1]).toBe('https://host.example')
		win.receive({ ...hello, kind: 'callback', id: '1' }, win.parent, 'https://other.example')
		expect(callback).not.toHaveBeenCalled()
	})
})
