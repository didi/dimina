import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
	offTouchStart,
	onTouchStart,
} from '../src/api/core/device/touch/index.js'
import { emitGameTouch, resetGameTouchEvents } from '../src/core/game-events.js'

describe('mini game touch events', () => {
	beforeEach(() => resetGameTouchEvents())

	it('delivers touch payloads and supports removing one or all listeners', () => {
		const first = vi.fn()
		const second = vi.fn()
		onTouchStart(first)
		onTouchStart(second)
		const event = { touches: [{ identifier: 1, clientX: 20, clientY: 30 }] }
		emitGameTouch('touchstart', event)
		expect(first).toHaveBeenCalledWith(event)
		expect(second).toHaveBeenCalledWith(event)

		offTouchStart(first)
		emitGameTouch('touchstart', event)
		expect(first).toHaveBeenCalledTimes(1)
		expect(second).toHaveBeenCalledTimes(2)

		offTouchStart()
		emitGameTouch('touchstart', event)
		expect(second).toHaveBeenCalledTimes(2)
	})
})
