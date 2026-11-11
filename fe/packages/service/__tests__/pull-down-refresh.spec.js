import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { callback } from '@dimina/common'
import { startPullDownRefresh, stopPullDownRefresh } from '../src/api/core/ui/pull-down-refresh'
import message from '../src/core/message'
import router from '../src/core/router'
import { canIUse } from '../src/api/core/base'

beforeEach(() => {
	vi.spyOn(router, 'getPageInfo').mockReturnValue({ id: 'refresh-page' })
	vi.spyOn(message, 'send').mockImplementation(() => {})
	vi.spyOn(message, 'invoke').mockImplementation(() => {})
})
afterEach(() => { callback.remove(); vi.restoreAllMocks() })
it('advertises the render-backed refresh APIs without probing a native method', () => {
	expect(canIUse('startPullDownRefresh')).toBe(true)
	expect(canIUse('stopPullDownRefresh')).toBe(true)
	expect(message.invoke).not.toHaveBeenCalled()
})
it.each([startPullDownRefresh, stopPullDownRefresh])('routes %s to the current render page and preserves callbacks', (api) => {
	const success = vi.fn(), complete = vi.fn()
	api({ success, complete })
	expect(message.send).toHaveBeenCalledOnce()
	const msg = message.send.mock.calls[0][0]
	expect(msg.target).toBe('render'); expect(msg.body.bridgeId).toBe('refresh-page')
	expect(message.invoke).not.toHaveBeenCalled()
	const result = { errMsg: `${msg.body.name}:ok` }
	callback.invoke(msg.body.params.success, result); callback.invoke(msg.body.params.complete, result)
	expect(success).toHaveBeenCalledWith(result); expect(complete).toHaveBeenCalledWith(result)
})
it('supports an omitted options object and a rejected promise', async () => {
	const result = startPullDownRefresh()
	const msg = message.send.mock.calls[0][0]
	callback.invoke(msg.body.params.fail, { errMsg: 'startPullDownRefresh:fail page not ready' })
	await expect(result).rejects.toMatchObject({ errMsg: 'startPullDownRefresh:fail page not ready' })
})
