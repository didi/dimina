import { afterEach, describe, expect, it, vi } from 'vitest'
import wx from '../src/api/index.js'

function notify(height) {
	globalThis.DiminaServiceBridge.onMessage({ type: 'keyboardHeightChange', body: { height } })
}

describe('global keyboard height API', () => {
	afterEach(() => wx.offKeyboardHeightChange?.())

	it('exposes both APIs and forwards height changes including dismissal', () => {
		for (const name of ['onKeyboardHeightChange', 'offKeyboardHeightChange']) {
			expect(wx[name]).toBeTypeOf('function')
			expect(wx.canIUse(name)).toBe(true)
		}
		const listener = vi.fn()
		wx.onKeyboardHeightChange(listener)
		wx.onKeyboardHeightChange(listener)
		for (const height of [0, 260, 260, '260', -1, 300, 0, 0]) notify(height)
		expect(listener.mock.calls).toEqual([[{ height: 260 }], [{ height: 300 }], [{ height: 0 }]])
	})

	it('removes one listener by identity, or all listeners when called without arguments', () => {
		const first = vi.fn()
		const second = vi.fn()
		wx.onKeyboardHeightChange(first)
		wx.onKeyboardHeightChange(second)
		notify(300)
		wx.offKeyboardHeightChange(first)
		notify(250)
		wx.offKeyboardHeightChange()
		notify(0)
		expect(first.mock.calls).toEqual([[{ height: 300 }]])
		expect(second.mock.calls).toEqual([[{ height: 300 }], [{ height: 250 }]])
	})
})
