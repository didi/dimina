import fs from 'node:fs'
import { resolve } from 'node:path'
import type { Bridge } from '../src/core/bridge.js'
import { describe, expect, it, vi } from 'vitest'
import { MiniApp } from '../src/pages/miniApp/miniApp.js'
import { Navigator } from '../src/pages/miniApp/navigator.js'

// 桩造一个 MiniApp：只填 showModal/_mountModal/_lockModalPageTouch 用到的字段，
// 沿用 navigation-callbacks.spec.ts 建立的 Object.create(MiniApp.prototype) 套路——
// 绕开构造函数，字段之间彼此不满足真实类型约束，先按 Record<string, unknown> 自由赋值。
function createApp(): MiniApp {
	const app: Record<string, unknown> = Object.create(MiniApp.prototype)
	app.el = document.createElement('div')
	app._modalStack = []
	app._modalPendingTimers = new Set()
	app._modalPageTouchTarget = null
	app._destroyed = false
	app.navigator = new Navigator()
	return app as unknown as MiniApp
}

describe('showModal touch boundary', () => {
	it('registers a non-passive touchmove listener on the mask that calls preventDefault', () => {
		const app = createApp()

		const entry = app._mountModal({})
		app._modalStack.push(entry)

		const event = new Event('touchmove', { cancelable: true })
		const preventDefaultSpy = vi.spyOn(event, 'preventDefault')
		entry.mask.dispatchEvent(event)

		expect(preventDefaultSpy).toHaveBeenCalledOnce()
	})

	it('blocks an active iframe touch stream while a modal is open and unlocks once the last one closes', () => {
		const app = createApp()
		const pageListeners = new Map<string, { listener: (e: unknown) => void, options: unknown }>()
		const pageWindow = {
			addEventListener: vi.fn((type: string, listener: (e: unknown) => void, options: unknown) => {
				pageListeners.set(type, { listener, options })
			}),
			removeEventListener: vi.fn(),
		}
		app.navigator.pushPage({ webview: { iframe: { contentWindow: pageWindow } } } as unknown as Bridge)

		app.showModal({})

		const touchMove = pageListeners.get('touchmove')!
		expect(touchMove.options).toEqual({ capture: true, passive: false })

		const event = { cancelable: true, preventDefault: vi.fn(), stopImmediatePropagation: vi.fn() }
		touchMove.listener(event)
		expect(event.preventDefault).toHaveBeenCalledOnce()
		expect(event.stopImmediatePropagation).toHaveBeenCalledOnce()

		app._modalStack[0].close!({ cancel: false, confirm: true, errMsg: 'showModal:ok' })

		expect(pageWindow.removeEventListener).toHaveBeenCalledWith('touchmove', expect.any(Function), true)
		expect(app._modalPageTouchTarget).toBeNull()
	})

	it('keeps scrolling inside modal content and contains its overscroll (CSS contract)', () => {
		const styles = fs.readFileSync(resolve(__dirname, '../src/pages/miniApp/miniApp.scss'), 'utf8')
		const maskRule = styles.match(/\.dimina-dialog-mask\s*\{([\s\S]*?)\n\}/)?.[1]
		const contentRule = styles.match(/\.dimina-dialog__content\s*\{([\s\S]*?)\n\t\}/)?.[1]

		expect(maskRule).toMatch(/touch-action:\s*none/)
		expect(contentRule).toMatch(/overflow-y:\s*auto/)
		expect(contentRule).toMatch(/overscroll-behavior:\s*contain/)
		expect(contentRule).toMatch(/touch-action:\s*pan-y/)
	})
})
