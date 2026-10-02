import { describe, expect, it, vi } from 'vitest'
import type { MiniApp } from '../src/pages/miniApp/miniApp.js'
import { JSCore } from '../src/core/jscore.js'

describe('Canvas Worker transfer transport', () => {
	it('transfers ownership before posting the selector callback on the same Worker', () => {
		const jscore = new JSCore({ _destroyed: false } as unknown as MiniApp)
		const postMessage = vi.fn()
		jscore.worker = { postMessage } as unknown as Worker
		const canvas = {} as OffscreenCanvas
		jscore.postMessage({ type: 'canvasTransfer', target: 'service', body: { bridgeId: 'page', nodeId: 'canvas', canvas }, transferables: [canvas] })
		jscore.postMessage({ type: 'triggerCallback', target: 'service', body: { bridgeId: 'page', id: 'selector' } })
		expect(postMessage.mock.calls).toEqual([
			[{ type: 'canvasTransfer', target: 'service', body: { bridgeId: 'page', nodeId: 'canvas', canvas } }, [canvas]],
			[{ type: 'triggerCallback', target: 'service', body: { bridgeId: 'page', id: 'selector' } }],
		])
	})
})
