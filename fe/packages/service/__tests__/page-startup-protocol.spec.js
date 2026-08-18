import { beforeEach, describe, expect, it, vi } from 'vitest'
import loader from '../src/core/loader'
import runtime from '../src/core/runtime'
import { PageModule } from '../src/instance/page/page-module'
import '../src/index'

describe('page startup protocol', () => {
	beforeEach(() => {
		runtime.instances = {}
		runtime.pageStates.clear()
		globalThis.DiminaServiceBridge.publish = vi.fn()
	})

	it('sends firstRender before initial data and waits for a real pageShow signal', () => {
		const calls = []
		const bridgeId = 'bridge-startup-order'
		const path = 'pages/startup-order/index'
		loader.staticModules[path] = new PageModule({
			onLoad: () => calls.push('page:onLoad'),
			onShow: () => calls.push('page:onShow'),
		}, {
			path,
			usingComponents: {},
		})

		try {
			globalThis.DiminaServiceBridge.onMessage({
				type: 'resourceLoaded',
				body: {
					bridgeId,
					pagePath: path,
					query: {},
					scene: 1001,
				},
			})

			const messages = globalThis.DiminaServiceBridge.publish.mock.calls.map(([, message]) => message)
			expect(messages).toHaveLength(2)
			expect(messages[0].type).toBe('firstRender')
			expect(messages[1].type).toBe(messages[0].body.pageId)
			expect(calls).toEqual(['page:onLoad'])

			globalThis.DiminaServiceBridge.onMessage({
				type: 'pageShow',
				body: { bridgeId },
			})
			expect(calls).toEqual(['page:onLoad', 'page:onShow'])

			globalThis.DiminaServiceBridge.onMessage({
				type: 'pageUnload',
				body: { bridgeId },
			})
		}
		finally {
			delete loader.staticModules[path]
		}
	})
})
