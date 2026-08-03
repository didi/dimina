import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createContainer } from '../src/index.js'
import { resetFakeWorker } from './fixtures/fake-worker.js'
import { installFetchMock } from './fixtures/mock-fetch.js'

// AppManager 内部存储从 appStack: MiniApp[]（线性数组，谁也不消费其顺序）
// 改造为 apps: Map<string, MiniApp>（appId 键控注册表）。这份测试锁定
// 该重构前后必须保持不变的公开行为契约（1-4），并单独放一条直接命中
// 新内部形状的断言（5）——(5) 在改造落地前应当失败，改造落地后应当转绿。

describe('AppManager 内部存储从数组重构为 Map 的行为契约', () => {
	let mount: HTMLElement

	beforeEach(() => {
		installFetchMock()
		resetFakeWorker()
		mount = document.createElement('div')
		document.body.appendChild(mount)
	})

	// 契约 1：getAppById 按 appId 精确检索，不存在的 id 返回 null。
	it('getAppById 为每个已打开的 appId 返回对应实例，未打开的 id 返回 null', async () => {
		const container = createContainer({ mount })

		const miniAppA = await container.openApp({ appId: 'wx-registry-a', path: 'pages/index/index' })
		const miniAppB = await container.openApp({ appId: 'wx-registry-b', path: 'pages/index/index' })

		expect(container.application.appManager.getAppById('wx-registry-a')).toBe(miniAppA)
		expect(container.application.appManager.getAppById('wx-registry-b')).toBe(miniAppB)
		expect(container.application.appManager.getAppById('wx-registry-does-not-exist')).toBeNull()
	}, 10000)

	// 契约 2：同一 appId 重复 openApp 复用缓存实例，而不是新建第二份。
	it('同一 appId 重复 openApp 返回同一个实例（对象引用相等）', async () => {
		const container = createContainer({ mount })

		const first = await container.openApp({ appId: 'wx-registry-reuse', path: 'pages/index/index' })
		const second = await container.openApp({ appId: 'wx-registry-reuse', path: 'pages/index/index' })

		expect(second).toBe(first)
		expect(container.application.appManager.getAppById('wx-registry-reuse')).toBe(first)
	}, 10000)

	// 契约 3：destroy:true 完整销毁旧实例后，其 appId 在 getAppById 里查不到了，
	// 不会残留旧的缓存对象。
	it('destroy:true 打开另一个 appId 后，旧 appId 完整销毁，getAppById 查不到旧实例', async () => {
		const container = createContainer({ mount })

		const miniAppA = await container.openApp({ appId: 'wx-registry-destroy-a', path: 'pages/index/index' })
		expect(container.application.appManager.getAppById('wx-registry-destroy-a')).toBe(miniAppA)

		await container.openApp({ appId: 'wx-registry-destroy-b', path: 'pages/index/index', destroy: true })

		await vi.waitFor(() => {
			expect(container.application.appManager.getAppById('wx-registry-destroy-a')).toBeNull()
		}, { timeout: 8000 })

		expect(container.application.appManager.getAppById('wx-registry-destroy-b')).not.toBeNull()
	}, 15000)

	// 契约 4：registerApi 广播到所有当前已打开的实例，而不只是最近一个。
	it('registerApi 广播到所有当前已打开的实例', async () => {
		const container = createContainer({ mount })

		const miniAppA = await container.openApp({ appId: 'wx-registry-broadcast-a', path: 'pages/index/index' })
		const miniAppB = await container.openApp({ appId: 'wx-registry-broadcast-b', path: 'pages/index/index' })

		const handler = vi.fn()
		container.registerApi('qdRegistryBroadcastProbe', handler)

		expect(miniAppA.apiRegistry.qdRegistryBroadcastProbe).toBe(handler)
		expect(miniAppB.apiRegistry.qdRegistryBroadcastProbe).toBe(handler)
	}, 10000)

	// 契约 5（本轮重构的 RED 信号）：内部字段应当是 apps: Map<string, MiniApp>，
	// 不再是 appStack 数组——这条直接命中被改造的内部形状，在改造落地前会失败。
	it('内部存储字段是 apps: Map，不再是 appStack 数组', async () => {
		const container = createContainer({ mount })
		await container.openApp({ appId: 'wx-registry-shape', path: 'pages/index/index' })

		// eslint-disable-next-line ts/no-explicit-any -- 探测重构前后都存在过的历史字段名，两侧类型不统一
		const appManager = container.application.appManager as any

		expect(appManager.appStack).toBeUndefined()
		expect(appManager.apps instanceof Map).toBe(true)
	}, 10000)
})
