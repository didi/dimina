import { expect, it, vi } from 'vitest'
import message from '../src/core/message.js'

it('delivers binary callback messages without serializing the payload for logging', () => {
	const data = new Uint8Array(8 * 1024 * 1024).fill(173).buffer
	const received = vi.fn()
	message.on('triggerCallback', received)
	const stringify = vi.spyOn(JSON, 'stringify')
	let calls
	try {
		message.handleMsg({ type: 'triggerCallback', body: { id: 'file-read', args: { data } } })
		calls = stringify.mock.calls.length
	}
	finally {
		stringify.mockRestore()
		message.off('triggerCallback')
	}
	expect(received).toHaveBeenCalledOnce()
	expect(received.mock.calls[0][0].args.data).toBe(data)
	expect(calls).toBe(0)
})
