import { beforeEach, expect, it, vi } from 'vitest'
import { createContainer } from '../src/index.js'
import { FakeWorker, resetFakeWorker } from './fixtures/fake-worker.js'
import { installFetchMock } from './fixtures/mock-fetch.js'

beforeEach(() => {
	installFetchMock()
	resetFakeWorker()
})

it('restores A after opening and hiding B without replacing its runtime or page', async () => {
	const mount = document.createElement('div')
	document.body.appendChild(mount)
	const container = createContainer({ mount })
	const first = await container.openApp({ appId: 'retained-a' })
	const page = first.navigator.top
	const worker = FakeWorker.instances[0]
	const hide = async () => {
		container.closeApp()
		await vi.waitFor(() => expect(container.application.views).toHaveLength(0))
	}
	await hide()
	const second = await container.openApp({ appId: 'retained-b' })
	await hide()

	expect(await container.openApp({ appId: 'retained-a' })).toBe(first)
	expect(first.navigator.top).toBe(page)
	expect(worker.terminate).not.toHaveBeenCalled()
	expect(container.application.appManager.getAppById('retained-b')).toBe(second)
	expect(FakeWorker.instances).toHaveLength(2)
	await container.application.destroyRootView(first)
	await container.application.destroyRootView(second)
	mount.remove()
}, 10000)

it('refreshes host entry options without reviving an old mini-program opener', async () => {
	const mount = document.createElement('div')
	document.body.appendChild(mount)
	const container = createContainer({ mount })
	const manager = container.application.appManager
	const source = await container.openApp({ appId: 'source' })
	const target = await manager.navigateToMiniProgram({ appId: 'target', extraData: { old: true } }, source)
	const worker = FakeWorker.instances[1]
	const page = target.navigator.top
	type WorkerMessage = { type: string, body?: Record<string, unknown> }
	const messages = (): WorkerMessage[] => worker.postMessage.mock.calls.map(([msg]: [WorkerMessage]) => msg)
	await vi.waitFor(() => expect(messages().some(msg => msg.type === 'loadResource')).toBe(true))
	await container.application.dismissView(target, { destroy: false })
	await container.application.dismissView(source, { destroy: false })

	const lastShow = () => messages().filter(msg => msg.type === 'appShow').at(-1)?.body
	try {
		expect(await container.openApp({ appId: 'target', scene: 1011 })).toBe(target)
		expect(target.navigator.top).toBe(page)
		expect(target.opener).toBeNull()
		expect(lastShow()).toEqual({
			scene: 1011, path: target.getCurrentPagePath(), query: target.getCurrentPageQuery(), referrerInfo: {},
		})
		await expect(manager.navigateBackMiniProgram(target, {}, async () => {})).rejects.toThrow('not opened by another mini program')

		await container.application.dismissView(target, { destroy: false })
		await container.openApp({ appId: 'target' })
		expect(lastShow()?.scene).toBe(1001)
		expect(worker.terminate).not.toHaveBeenCalled()
	} finally {
		await container.application.destroyRootView(target)
		await container.application.destroyRootView(source)
		mount.remove()
	}
})


it('reclaims a hidden runtime after capacity reduction and rebuilds it on next entry', async () => {
	const mount = document.createElement('div')
	document.body.appendChild(mount)
	const container = createContainer({ mount, retention: { maxBackgroundApps: 1, backgroundTimeoutMs: 0 } })
	const first = await container.openApp({ appId: 'evict-a' })
	await container.application.dismissView(first, { destroy: false })
	const second = await container.openApp({ appId: 'evict-b' })
	container.configureRetention({ maxBackgroundApps: 0, backgroundTimeoutMs: 0 })
	await vi.waitFor(() => expect(container.application.appManager.getAppById(first.appId)).toBeNull())
	expect(FakeWorker.instances[0].terminate).toHaveBeenCalledTimes(1)
	expect(container.application.views.at(-1)).toBe(second)
	const restored = await container.openApp({ appId: 'evict-a' })
	expect(restored).not.toBe(first)
	await container.application.destroyRootView(restored)
	await container.application.destroyRootView(second)
	mount.remove()
})


it('checks expiry before reopening even when the host expiry timer has not run', async () => {
	const clock = vi.spyOn(performance, 'now').mockReturnValue(0)
	const mount = document.createElement('div')
	const container = createContainer({ mount, retention: { backgroundTimeoutMs: 100000 } })
	try {
		const first = await container.openApp({ appId: 'expired-entry' })
		await container.application.dismissView(first, { destroy: false })
		clock.mockReturnValue(100001)
		const reopened = await container.openApp({ appId: first.appId })
		expect(reopened).not.toBe(first)
		expect(FakeWorker.instances[0].terminate).toHaveBeenCalledTimes(1)
		expect(container.application.views.at(-1)).toBe(reopened)
	} finally {
		for (const app of [...container.application.appManager.apps.values()]) await container.application.destroyRootView(app)
		clock.mockRestore()
	}
})

it('keeps a cross-app return chain usable under memory pressure and a zero cache limit', async () => {
	const container = createContainer({ mount: document.createElement('div'), retention: { maxBackgroundApps: 0 } })
	const manager = container.application.appManager
	try {
		const source = await container.openApp({ appId: 'pinned-source' })
		const target = await manager.navigateToMiniProgram({ appId: 'pinned-target' }, source)
		container.notifyMemoryPressure()
		await manager._enqueue(async () => {})
		expect(manager.getAppById(source.appId)).toBe(source)
		expect(manager.getAppById(target.appId)).toBe(target)
		await manager.navigateBackMiniProgram(target, {}, async () => {})
		expect(container.application.views.at(-1)).toBe(source)
		expect(FakeWorker.instances[0].terminate).not.toHaveBeenCalled()
	} finally {
		for (const app of [...manager.apps.values()]) await container.application.destroyRootView(app)
	}
})

it('isolates memory pressure across containers even when appIds match', async () => {
	const one = createContainer({ mount: document.createElement('div') })
	const two = createContainer({ mount: document.createElement('div') })
	try {
		const a = await one.openApp({ appId: 'same-id' })
		const b = await two.openApp({ appId: 'same-id' })
		await one.application.dismissView(a, { destroy: false })
		await two.application.dismissView(b, { destroy: false })
		one.notifyMemoryPressure()
		await one.application.appManager._enqueue(async () => {})
		expect(one.application.appManager.getAppById('same-id')).toBeNull()
		expect(two.application.appManager.getAppById('same-id')).toBe(b)
		expect(await two.openApp({ appId: 'same-id' })).toBe(b)
	} finally {
		for (const container of [one, two]) {
			for (const app of [...container.application.appManager.apps.values()]) await container.application.destroyRootView(app)
		}
	}
})
