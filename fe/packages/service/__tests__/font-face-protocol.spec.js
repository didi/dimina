import { describe, expect, it, vi } from 'vitest'
import fonts from '../src/core/font-face'
import loader from '../src/core/loader'
import runtime from '../src/core/runtime'
import { PageModule } from '../src/instance/page/page-module'
import '../src/index'

describe('font loading startup barrier', () => {
	it('waits for the font acknowledgement before firstRender and replays before rendering a new page', async () => {
		const path = 'pages/font-protocol/index'
		loader.staticModules[path] = new PageModule({}, { path, usingComponents: {} })
		const publish = vi.fn()
		globalThis.DiminaServiceBridge.publish = publish
		const send = (type, body) => globalThis.DiminaServiceBridge.onMessage({ type, body })
		const bodies = () => publish.mock.calls.map(([, msg]) => msg)
		try {
			fonts.beginPage('first-font-page')
			const loaded = fonts.load({ family: 'Brand', source: 'url("dimina-font://brand")', global: true }, 'first-font-page')
			for (const id of ['first-font-page', 'second-font-page']) {
				publish.mockClear()
				send('resourceLoaded', { bridgeId: id, pagePath: path, query: {}, resourceLoadId: id })
				expect(bodies().some(msg => msg.type === 'firstRender')).toBe(false)
				const request = bodies().find(msg => msg.type === 'invokeAPI' && msg.body.name === 'loadFontFace')
				expect(request).toBeDefined()
				send('fontFaceLoaded', { bridgeId: id, requestId: request.body.params.requestId })
				await vi.waitFor(() => expect(bodies().some(msg => msg.type === 'firstRender')).toBe(true))
			}
			await loaded
		}
		finally {
			for (const id of ['first-font-page', 'second-font-page']) {
				fonts.removePage(id)
				if (runtime.instances[id]) runtime.pageUnload({ bridgeId: id })
			}
			fonts.globals.clear()
			delete loader.staticModules[path]
		}
	})
})
