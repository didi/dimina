import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDataFunctionReference } from '@dimina/common'

describe('render message handshake', () => {
	afterEach(() => {
		vi.resetModules()
		delete globalThis.window
	})

	it('registers the response listener before sending a synchronous request', async () => {
		globalThis.window = {
			DiminaRenderBridge: {
				publish: vi.fn((rawMessage) => {
					const request = JSON.parse(rawMessage)
					window.DiminaRenderBridge.onMessage({
						type: request.body.moduleId,
						body: { data: { created: true } },
					})
				}),
			},
		}

		const message = (await import('../src/core/message')).default
		const response = await message.waitAndSend('component-1', {
			type: 'mC',
			target: 'service',
			body: { bridgeId: 'bridge-1', moduleId: 'component-1' },
		})

		expect(response).toEqual({ created: true })
		expect(window.DiminaRenderBridge.publish).toHaveBeenCalledTimes(1)
	})

	it('hydrates stable function proxies and serializes them back to references', async () => {
		globalThis.window = {
			DiminaRenderBridge: {
				publish: vi.fn(),
			},
		}

		const message = (await import('../src/core/message')).default
		const received = vi.fn()
		message.on('data-functions', received)
		const reference = createDataFunctionReference('function-1')

		window.DiminaRenderBridge.onMessage({
			type: 'data-functions',
			body: {
				fn: reference,
				list: [reference],
			},
		})

		const body = received.mock.calls[0][0]
		expect(body.fn).toBeTypeOf('function')
		expect(body.list[0]).toBe(body.fn)
		expect(JSON.parse(JSON.stringify(body))).toEqual({
			fn: reference,
			list: [reference],
		})
	})
})
