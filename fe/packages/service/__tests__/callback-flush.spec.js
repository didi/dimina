import { beforeEach, describe, expect, it, vi } from 'vitest'
import '../src/index'

describe('destructive API callback FIFO barrier', () => {
	beforeEach(() => {
		globalThis.DiminaServiceBridge.invoke = vi.fn()
	})

	it('acknowledges flushCallbacks only after earlier worker messages have been handled', () => {
		globalThis.DiminaServiceBridge.onMessage({
			type: 'flushCallbacks',
			body: { requestId: 'flush-1' },
		})

		expect(globalThis.DiminaServiceBridge.invoke).toHaveBeenCalledWith({
			type: 'callbacksFlushed',
			target: 'container',
			body: { requestId: 'flush-1' },
		})
	})
})
