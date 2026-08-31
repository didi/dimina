import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MiniApp } from '../src/pages/miniApp/miniApp'

/**
 * `globalThis.addEventListener` is an overloaded DOM signature; a spy only has to record the two arguments this code path passes, so it is installed through the shape the assertions read and cast once at the assignment.
 */
type ResizeListenerSpy = ReturnType<typeof vi.fn<(type: string, listener: () => void) => void>>

describe('web window resize listener ownership', () => {
	let originalAddEventListener: typeof globalThis.addEventListener
	let originalRemoveEventListener: typeof globalThis.removeEventListener
	let addEventListener: ResizeListenerSpy
	let removeEventListener: ResizeListenerSpy
	let postMessage: ReturnType<typeof vi.fn>
	let app: MiniApp

	beforeEach(() => {
		originalAddEventListener = globalThis.addEventListener
		originalRemoveEventListener = globalThis.removeEventListener
		addEventListener = vi.fn()
		removeEventListener = vi.fn()
		globalThis.addEventListener = addEventListener as unknown as typeof globalThis.addEventListener
		globalThis.removeEventListener = removeEventListener as unknown as typeof globalThis.removeEventListener

		postMessage = vi.fn()
		app = Object.create(MiniApp.prototype) as MiniApp
		app._windowResizeHandlers = new Map()
		app.jscore = { postMessage } as unknown as MiniApp['jscore']
	})

	afterEach(() => {
		globalThis.addEventListener = originalAddEventListener
		globalThis.removeEventListener = originalRemoveEventListener
	})

	/** Viewport geometry the real getSystemInfoSync measures, without a DOM. */
	function stubViewport(width: number, height: number): void {
		app.parent = {
			el: {
				querySelector: () => ({
					getBoundingClientRect: () => ({ width, height }),
				}),
			},
		} as unknown as MiniApp['parent']
		app.el = { clientWidth: 0, clientHeight: 0 } as unknown as HTMLElement
		app._getStatusBarRect = () => ({ top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0 })
	}

	it('reuses one browser handler for a repeated evtId', () => {
		stubViewport(844, 390)

		app.onWindowResize({ success: 'resize-listener' })
		app.onWindowResize({ success: 'resize-listener' })

		expect(addEventListener).toHaveBeenCalledTimes(1)
		expect(app._windowResizeHandlers.size).toBe(1)

		const handler = addEventListener.mock.calls[0][1]
		handler()
		expect(postMessage).toHaveBeenCalledWith({
			type: 'triggerCallback',
			body: {
				id: 'resize-listener',
				args: {
					size: { windowWidth: 844, windowHeight: 390 },
					deviceOrientation: 'landscape',
				},
			},
		})
	})

	it('removes only the handler owned by the supplied evtId', () => {
		app.onWindowResize({ success: 'first' })
		app.onWindowResize({ success: 'second' })
		const firstHandler = app._windowResizeHandlers.get('first')
		const secondHandler = app._windowResizeHandlers.get('second')

		app.offWindowResize({ success: 'first' })

		expect(removeEventListener).toHaveBeenCalledWith('resize', firstHandler)
		expect(removeEventListener).not.toHaveBeenCalledWith('resize', secondHandler)
		expect(Array.from(app._windowResizeHandlers.keys())).toEqual(['second'])
	})

	it('reports landscape from the current web viewport geometry', () => {
		stubViewport(844, 390)

		expect(app.getSystemInfoSync().deviceOrientation).toBe('landscape')

		app.getSystemInfoAsync({ success: 'success', complete: 'complete' })

		const successCall = postMessage.mock.calls
			.map(([message]) => message as { body: { id: string, args?: { deviceOrientation?: string } } })
			.find(message => message.body.id === 'success')
		expect(successCall?.body.args?.deviceOrientation).toBe('landscape')
	})

	it('removes every owned handler when no evtId is supplied', () => {
		app.onWindowResize({ success: 'first' })
		app.onWindowResize({ success: 'second' })
		const handlers = Array.from(app._windowResizeHandlers.values())

		app.offWindowResize()

		expect(removeEventListener.mock.calls).toEqual(handlers.map(handler => ['resize', handler]))
		expect(app._windowResizeHandlers.size).toBe(0)
	})
})
