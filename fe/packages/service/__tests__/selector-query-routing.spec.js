import { callback } from '@dimina/common'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createSelectorQuery } from '../src/api/core/wxml/selector-query'
import router from '../src/core/router'
import message from '../src/core/message'

beforeEach(() => {
	vi.spyOn(router, 'getPageInfo').mockReturnValue({ id: 'page-a', bridgeId: 'page-a', __id__: 'module-a' })
	vi.spyOn(message, 'send').mockImplementation(() => {})
})
afterEach(() => { callback.remove(); vi.restoreAllMocks() })

it('keeps its creation page when navigation happens before the first task or execution', () => {
	const query = createSelectorQuery()
	vi.mocked(router.getPageInfo).mockReturnValue({ id: 'page-b', bridgeId: 'page-b', __id__: 'module-b' })
	query.select('#target').boundingClientRect().exec()
	expect(message.send).toHaveBeenLastCalledWith(expect.objectContaining({ body: expect.objectContaining({
		bridgeId: 'page-a', params: expect.objectContaining({ tasks: [expect.objectContaining({ moduleId: 'module-a' })] }),
	}) }))
})

it('routes an explicitly selected old component to its own bridge', () => {
	createSelectorQuery().in({ __id__: 'old-component', bridgeId: 'old-page' }).select('.node').boundingClientRect().exec()
	expect(message.send).toHaveBeenLastCalledWith(expect.objectContaining({ body: expect.objectContaining({
		bridgeId: 'old-page', params: expect.objectContaining({ tasks: [expect.objectContaining({ moduleId: 'old-component' })] }),
	}) }))
})

it('ignores a cross-page in() after the first task fixes the query page', () => {
	vi.spyOn(console, 'error').mockImplementation(() => {})
	const query = createSelectorQuery().select('#first').boundingClientRect()
	query.in({ __id__: 'module-b', bridgeId: 'page-b' }).select('#second').boundingClientRect().exec()
	expect(console.error).toHaveBeenCalledOnce()
	const { bridgeId, params } = message.send.mock.calls[0][0].body
	expect(bridgeId).toBe('page-a')
	expect(params.tasks.map(task => task.moduleId)).toEqual(['module-a', 'module-a'])
})
