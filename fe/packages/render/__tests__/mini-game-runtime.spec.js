import { beforeEach, describe, expect, it, vi } from 'vitest'

const { send } = vi.hoisted(() => ({ send: vi.fn() }))
vi.mock('../src/core/message', () => ({ default: { send } }))

import runtime from '../src/core/runtime.js'

describe('mini game render surface', () => {
	beforeEach(() => {
		send.mockReset()
		document.body.innerHTML = ''
		runtime.canvasNodes.clear()
	})

	it('mounts one full-screen canvas and forwards touch and simulated mouse events to service', () => {
		runtime.createGameCanvas({
			bridgeId: 'bridge-game',
			params: { nodeId: 'game-canvas', width: 390, height: 844, type: '2d' },
		})
		const canvas = document.querySelector('[data-dimina-game-canvas]')
		expect(canvas).toBeInstanceOf(HTMLCanvasElement)
		expect(canvas.width).toBe(390)
		expect(canvas.height).toBe(844)
		expect(canvas.style.touchAction).toBe('none')

		const event = new Event('touchstart', { cancelable: true })
		Object.defineProperties(event, {
			touches: { value: [{ identifier: 7, clientX: 12, clientY: 34, pageX: 12, pageY: 34, force: 0.5 }] },
			changedTouches: { value: [{ identifier: 7, clientX: 12, clientY: 34, pageX: 12, pageY: 34, force: 0.5 }] },
		})
		canvas.dispatchEvent(event)

		expect(send).toHaveBeenCalledWith(expect.objectContaining({
			type: 'gameTouch',
			target: 'service',
			body: expect.objectContaining({
				bridgeId: 'bridge-game',
				eventType: 'touchstart',
				touches: [expect.objectContaining({ identifier: 7, clientX: 12, clientY: 34 })],
			}),
		}))
		send.mockClear()

		const hoverBeforeMouseDown = new Event('mousemove', { cancelable: true })
		Object.defineProperties(hoverBeforeMouseDown, {
			clientX: { value: 40 }, clientY: { value: 60 },
			pageX: { value: 40 }, pageY: { value: 60 },
		})
		canvas.dispatchEvent(hoverBeforeMouseDown)
		expect(send).not.toHaveBeenCalled()

		const mouseDown = new Event('mousedown', { cancelable: true })
		Object.defineProperties(mouseDown, {
			button: { value: 0 },
			clientX: { value: 56 },
			clientY: { value: 78 },
			pageX: { value: 56 },
			pageY: { value: 78 },
		})
		canvas.dispatchEvent(mouseDown)

		expect(send).toHaveBeenLastCalledWith(expect.objectContaining({
			type: 'gameTouch',
			target: 'service',
			body: expect.objectContaining({
				eventType: 'touchstart',
				touches: [expect.objectContaining({ identifier: 0, clientX: 56, clientY: 78 })],
			}),
		}))

		const mouseUp = new Event('mouseup', { cancelable: true })
		Object.defineProperties(mouseUp, {
			clientX: { value: 56 }, clientY: { value: 78 },
			pageX: { value: 56 }, pageY: { value: 78 },
		})
		canvas.dispatchEvent(mouseUp)

		const hoverMove = new Event('mousemove', { cancelable: true })
		Object.defineProperties(hoverMove, {
			clientX: { value: 90 }, clientY: { value: 120 },
			pageX: { value: 90 }, pageY: { value: 120 },
		})
		canvas.dispatchEvent(hoverMove)

		expect(send).toHaveBeenLastCalledWith(expect.objectContaining({
			body: expect.objectContaining({
				eventType: 'touchmove',
				touches: [expect.objectContaining({ clientX: 90, clientY: 120 })],
			}),
		}))
	})
})
