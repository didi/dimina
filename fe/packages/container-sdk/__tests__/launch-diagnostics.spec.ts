import { describe, expect, it, vi } from 'vitest'
import { createContainer } from '../src/index.js'
import { FakeWorker, setAutoRuntimeReady } from './fixtures/fake-worker.js'
import { installFetchMock } from './fixtures/mock-fetch.js'

function createHost() {
	const mount = document.createElement('div')
	document.body.appendChild(mount)
	return createContainer({ mount, appTransitions: false, urlSync: false, launchDiagnostics: { versions: { sdk: 'fixture' } } })
}

describe('launch diagnostics', () => {
	it('correlates ready signals with the current load and omits query parameters', async () => {
		installFetchMock()
		const container = createHost()
		const app = await container.openApp({ appId: 'demo', path: 'pages/index/index?private=value' })
		try {
			await app.whenReady()
			const report = container.getLaunchDiagnostics()
			expect(report).toBeDefined()
			const events = report!.events.filter(event => event.resourceLoadId)
			expect(events.map(event => event.phase)).toEqual(expect.arrayContaining([
				'resource-load-start', 'render-resources-ready', 'service-resources-ready', 'dom-ready', 'launch-ready',
			]))
			expect(new Set(events.map(event => event.bridgeId)).size).toBe(1)
			expect(new Set(events.map(event => event.resourceLoadId)).size).toBe(1)
			expect(report!.versions.sdk).toBe('fixture')
			expect(JSON.stringify(report)).not.toContain('private=value')
			expect(events.at(-1)?.pagePath).toBe('pages/index/index')
			report!.events.length = 0
			expect(container.getLaunchDiagnostics()?.events.length).toBeGreaterThan(0)
		}
		finally {
			await container.application.destroyRootView(app)
		}
	})

	it('reports a bad package configuration without copying the raw error', async () => {
		installFetchMock()
		vi.spyOn(console, 'error').mockImplementation(() => {})
		const container = createHost()
		const app = await container.openApp({ appId: 'demo', resourceContents: { 'main/app-config.json': '<private-response>' } })
		await expect(app.whenReady()).rejects.toThrow()
		const events = container.getLaunchDiagnostics()!.events
		expect(events.at(-1)).toMatchObject({ phase: 'launch-failed', failure: 'app-config' })
		expect(JSON.stringify(events)).not.toContain('private-response')
	})

	it('distinguishes a Worker error from a render resource failure', async () => {
		installFetchMock()
		vi.spyOn(console, 'error').mockImplementation(() => {})
		setAutoRuntimeReady(false)
		for (const failure of ['worker-error', 'render-resources']) {
			const container = createHost()
			const app = await container.openApp({ appId: failure })
			const rejected = expect(app.whenReady()).rejects.toThrow()
			await vi.waitFor(() => expect(app.navigator.top?.resourceLoadId).toBeTruthy())
			const bridge = app.navigator.top!
			if (failure === 'worker-error') {
				FakeWorker.instances.at(-1)?.onerror?.(new Error('fixture worker error'))
			}
			else {
				bridge.messageInvoke('render', {
					type: 'renderResourceLoadFailed',
					target: 'service',
					body: { bridgeId: bridge.id, resourceLoadId: bridge.resourceLoadId, errors: ['fixture render error'] },
				})
			}
			await rejected
			expect(container.getLaunchDiagnostics()?.events.at(-1)).toMatchObject({
				phase: 'launch-failed',
				failure,
				bridgeId: bridge.id,
			})
		}
	})
})
