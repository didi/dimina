import { beforeEach, expect, it, vi } from 'vitest'

vi.mock('@/api/common', () => ({ invokeAPI: vi.fn() }))
vi.mock('@/core/router', () => ({ default: { getPageInfo: () => ({ id: 'page', __id__: 'page-module', bridgeId: 'page' }) } }))

import { invokeAPI } from '@/api/common'
import { createSelectorQuery } from '../src/api/core/wxml/selector-query'

beforeEach(() => vi.mocked(invokeAPI).mockReset())

it('hydrates layout contexts before callbacks and sends commands to each selected component scope', () => {
	const callback = vi.fn()
	const query = createSelectorQuery().in({ __id__: 'component', bridgeId: 'page' })
	query.selectAll('.contexts').context(callback).exec()
	const success = vi.mocked(invokeAPI).mock.calls[0][1].success
	success([['video', 'map', 'canvas'].map(type => ({ context: {
		__diminaSelectorContext: true, type, id: `${type}-id`, moduleId: 'component',
	} }))])
	const [video, map, canvas] = callback.mock.calls[0][0].map(result => result.context)
	video.play()
	expect(invokeAPI).toHaveBeenLastCalledWith('videoContext', expect.objectContaining({ id: 'video-id', moduleId: 'component', command: 'play' }), 'render')
	map.getScale({ success: vi.fn() })
	expect(invokeAPI).toHaveBeenLastCalledWith('mapContext', expect.objectContaining({ mapId: 'map-id', moduleId: 'component', command: 'getScale', mapBridgeId: 'page' }), 'render')
	canvas.fillRect(0, 0, 1, 1)
	canvas.draw()
	expect(invokeAPI).toHaveBeenLastCalledWith('drawCanvas', expect.objectContaining({ canvasId: 'canvas-id', moduleId: 'component' }), 'render')
})
