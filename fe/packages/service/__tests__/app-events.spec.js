import { modDefine, modRequire } from '@dimina/common'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
	offAppHide,
	offAppShow,
	offError,
	offHide,
	offShow,
	onAppHide,
	onAppShow,
	onError,
	onHide,
	onShow,
} from '../src/api/core/base/app-event'
import { canIUse } from '../src/api/core/base'
import { resetAppEvents } from '../src/core/app-events'
import '../src/core/env'
import { invokeSafely } from '../src/core/safe-callback'
import { App } from '../src/instance/app/app'

function createApp(moduleInfo = {}, options = { scene: 1001, path: 'pages/index/index', query: {} }) {
	return new App({ moduleInfo: { globalData: {}, ...moduleInfo } }, options)
}

describe('application-level events', () => {
	beforeEach(() => {
		resetAppEvents()
		globalThis.DiminaServiceBridge.invoke = vi.fn()
	})

	it('implements all six APIs in the service layer and advertises them through canIUse', () => {
		const listener = vi.fn()

		expect(onError(listener)).toBeUndefined()
		expect(offError(listener)).toBeUndefined()
		expect(onAppShow(listener)).toBeUndefined()
		expect(offAppShow(listener)).toBeUndefined()
		expect(onAppHide(listener)).toBeUndefined()
		expect(offAppHide(listener)).toBeUndefined()

		for (const name of ['onError', 'offError', 'onAppShow', 'onAppHide', 'offAppShow', 'offAppHide', 'onShow', 'offShow', 'onHide', 'offHide']) {
			expect(canIUse(name)).toBe(true)
		}
		expect(globalThis.DiminaServiceBridge.invoke).not.toHaveBeenCalled()
	})

	it('shares mini game onShow/onHide aliases with application visibility events', () => {
		const calls = []
		const show = options => calls.push(['show', options])
		const hide = () => calls.push(['hide'])
		onShow(show)
		onHide(hide)
		const app = createApp()
		app.appHide()
		expect(calls).toEqual([['show', app.options], ['hide']])

		offShow(show)
		offHide(hide)
		app.appShow()
		app.appHide()
		expect(calls).toHaveLength(2)
	})

	it('runs App.onShow first, then every wx.onAppShow listener with the same options', () => {
		const calls = []
		const options = {
			scene: 1038,
			path: 'pages/index/index',
			query: { source: 'target' },
			referrerInfo: { appId: 'target-app', extraData: { value: 1 } },
		}
		const first = vi.fn((received) => calls.push(['wx:first', received]))
		const second = vi.fn((received) => calls.push(['wx:second', received]))
		onAppShow(first)
		onAppShow(second)

		createApp({
			onShow(received) {
				calls.push(['app', received])
			},
		}, options)

		expect(calls).toEqual([
			['app', options],
			['wx:first', options],
			['wx:second', options],
		])
	})

	it('runs App.onHide before wx.onAppHide and supports removing one or all listeners', () => {
		const calls = []
		const repeated = () => calls.push('repeated')
		const retained = () => calls.push('retained')
		onAppHide(repeated)
		onAppHide(repeated)
		onAppHide(retained)
		const app = createApp({ onHide: () => calls.push('app') })

		offAppHide(repeated)
		app.appHide()
		expect(calls).toEqual(['app', 'retained'])

		calls.length = 0
		offAppHide()
		app.appHide()
		expect(calls).toEqual(['app'])
	})

	it('uses an emit snapshot when listeners add or remove listeners during a callback', () => {
		const calls = []
		const added = () => calls.push('added')
		const second = () => calls.push('second')
		const first = () => {
			calls.push('first')
			offAppShow(second)
			onAppShow(added)
		}
		onAppShow(first)
		onAppShow(second)
		const app = createApp()

		expect(calls).toEqual(['first', 'second'])
		calls.length = 0
		app.appShow()
		expect(calls).toEqual(['first', 'added'])
	})

	it('delivers the same error string to App.onError and wx.onError without blocking later listeners', () => {
		const calls = []
		const throwingListener = () => {
			calls.push('wx:throw')
			throw new Error('error-listener-failed')
		}
		onError(throwingListener)
		onError((message) => calls.push(['wx:after', message]))

		createApp({
			onError(message) {
				calls.push(['app:error', message])
			},
			onShow() {
				throw new Error('show-failed')
			},
		})

		expect(calls[0][0]).toBe('app:error')
		expect(calls[0][1]).toContain('show-failed')
		expect(calls[1]).toBe('wx:throw')
		expect(calls[2][0]).toBe('wx:after')
		expect(calls[2][1]).toBe(calls[0][1])
		expect(calls.filter(item => Array.isArray(item) && item[0] === 'app:error')).toHaveLength(1)
	})

	it('reports errors caught by the shared safe-callback path', () => {
		const onAppError = vi.fn()
		const onWxError = vi.fn()
		onError(onWxError)
		createApp({ onError: onAppError })

		invokeSafely({}, () => {
			throw new TypeError('page-handler-failed')
		}, [], 'page handler')

		expect(onAppError).toHaveBeenCalledTimes(1)
		expect(onWxError).toHaveBeenCalledTimes(1)
		expect(onWxError.mock.calls[0][0]).toBe(onAppError.mock.calls[0][0])
		expect(onWxError.mock.calls[0][0]).toContain('page-handler-failed')
	})

	it('reports app module evaluation and uncaught runtime errors through the same channel', () => {
		const appError = vi.fn()
		const wxError = vi.fn()
		onError(wxError)
		createApp({ onError: appError })
		const moduleId = `throwing-app-event-module-${Date.now()}`
		modDefine(moduleId, () => {
			throw new Error('module-evaluation-failed')
		})

		modRequire(moduleId)
		globalThis.onerror('uncaught-runtime-failed')

		expect(appError).toHaveBeenCalledTimes(2)
		expect(wxError).toHaveBeenCalledTimes(2)
		expect(appError.mock.calls[0][0]).toContain('module-evaluation-failed')
		expect(wxError.mock.calls[0][0]).toBe(appError.mock.calls[0][0])
		expect(appError.mock.calls[1][0]).toBe('uncaught-runtime-failed')
		expect(wxError.mock.calls[1][0]).toBe(appError.mock.calls[1][0])
	})

	it('ignores invalid on/off arguments without mutating existing listeners', () => {
		const listener = vi.fn()
		const errorSpy = vi.spyOn(console, 'error')
		onAppShow(listener)

		onAppShow('invalid')
		offAppShow('invalid')
		createApp()

		expect(listener).toHaveBeenCalledTimes(1)
		expect(errorSpy).toHaveBeenCalledWith('onAppShow should accept a function instead of string')
		expect(errorSpy).toHaveBeenCalledWith('offAppShow should accept a function instead of string')
	})
})
