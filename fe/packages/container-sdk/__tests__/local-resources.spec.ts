import { describe, expect, it, vi } from 'vitest'
import { createContainer } from '../src/index.js'
import { createAppConfigResponse } from './fixtures/app-config.js'
import { FakeWorker } from './fixtures/fake-worker.js'
import type { BridgeMessage } from '../src/types.js'

describe('host-provided local packages', () => {
	it('opens configuration without fetch, forwards text to both loaders and waits for first DOM', async () => {
		const fetch = vi.fn(() => { throw new Error('network must not be used') })
		vi.stubGlobal('fetch', fetch)
		const mount = document.createElement('div')
		document.body.append(mount)
		const container = createContainer({ mount, urlSync: false })
		const resourceContents = {
			'main/app-config.json': JSON.stringify(createAppConfigResponse()),
			'main/logic.js': 'compiled logic',
		}
		const app = await container.openApp({ appId: 'local-app', resourceContents })
		await app.whenReady()
		expect(fetch).not.toHaveBeenCalled()
		const messages: BridgeMessage[] = FakeWorker.instances[0].postMessage.mock.calls.map((call: unknown[]) => call[0] as BridgeMessage)
		expect(messages.find(message => message.type === 'loadResource')?.body.resourceContents).toEqual(resourceContents)
		expect(app.navigator.top?.isStartupReady()).toBe(true)
		const frame = app.navigator.top!.webview!.iframe.contentWindow as unknown as { DiminaRenderBridge: { onMessage: ReturnType<typeof vi.fn> } }
		const renderMessages = frame.DiminaRenderBridge.onMessage.mock.calls.map(call => call[0] as BridgeMessage)
		expect(renderMessages.find(message => message.type === 'loadResource')?.body.resourceContents).toEqual(resourceContents)
		vi.unstubAllGlobals()
	})
	it('reports malformed local configuration through readiness and the launch callback', async () => {
		const mount = document.createElement('div')
		document.body.append(mount)
		const onAppLaunchError = vi.fn()
		const container = createContainer({ mount, onAppLaunchError, urlSync: false })
		const app = await container.openApp({ appId: 'local-broken', resourceContents: { 'main/app-config.json': '{' } })
		await expect(app.whenReady()).rejects.toThrow()
		expect(onAppLaunchError).toHaveBeenCalledOnce()
	})
})
