/**
 * 测试目标：验证 render 侧 _pendingSetups 机制能正确解决
 * IntersectionObserver 回调早于子组件 created 生命周期到达 service 侧的竞态问题，
 * 同时不影响在 created/onLoad 内直接调用 createIntersectionObserver 的场景。
 *
 * 背景：
 *   - service 侧 invokeAPI（addIntersectionObserver）在 render 侧同步分发
 *   - service 侧 setData（'u' 消息）在 render 侧经 queueMicrotask 延迟处理
 *   - 子组件 setup 中 await message.wait(moduleId) 需等 service created 完成才解除
 *   - IntersectionObserver 建立后若立即触发（元素已在视口），回调可能早于 created 到达 service
 *   - 修复：render 侧用 _pendingSetups Map 追踪"mC 已发出但 created 未完成"的组件
 *           addIntersectionObserver 在目标 DOM 出现后，等待所有 pending setup 完成，
 *           但排除调用方自身（moduleId），避免 onLoad/created 内调用时的死锁
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

// ─── 被测逻辑的最小实现（镜像自 runtime.js）────────────────────────────────────

class PendingSetupTracker {
	constructor() {
		// key: moduleId, value: Promise（created 完成时 resolve）
		this._pendingSetups = new Map()
	}

	/** 对应 setup 中 message.send('mC') 之后：记录此 moduleId 为 pending */
	beginSetup(moduleId) {
		let resolve
		this._pendingSetups.set(moduleId, new Promise(r => (resolve = r)))
		return resolve // 返回 resolve 供 completeSetup 调用
	}

	/** 对应 await message.wait(moduleId) 解除之后：移除 pending 并 resolve */
	completeSetup(moduleId, resolve) {
		this._pendingSetups.delete(moduleId)
		resolve()
	}

	/**
	 * 对应 addIntersectionObserver 中等待其他 pending setup 完成的逻辑
	 * 排除 excludeModuleId（observer 调用方自身），避免死锁
	 */
	waitForPendingExcept(excludeModuleId) {
		const pending = Array.from(this._pendingSetups.entries())
			.filter(([id]) => id !== excludeModuleId)
			.map(([, promise]) => promise)
		return pending.length > 0 ? Promise.all(pending) : Promise.resolve()
	}
}

// ─── 辅助：模拟 service 侧事件总线（对应 EventBus.once / emit）────────────────

function createEventBus() {
	const listeners = {}
	return {
		once(event, fn) {
			listeners[event] = fn
		},
		emit(event, payload) {
			if (listeners[event]) {
				listeners[event](payload)
				delete listeners[event]
			}
		},
		has(event) {
			return !!listeners[event]
		},
	}
}

// ─── 辅助：模拟组件初始化流程 ──────────────────────────────────────────────────

async function simulateComponentSetup(tracker, moduleId, eventBus, createdDelay = 0) {
	const resolve = tracker.beginSetup(moduleId)

	await new Promise(r => setTimeout(r, createdDelay))
	// service 侧 created 中注册事件
	eventBus.once('needFeedBack', () => {})

	tracker.completeSetup(moduleId, resolve)
}

// ─── 测试套件 ──────────────────────────────────────────────────────────────────

describe('_pendingSetups Map 基本行为', () => {
	let tracker

	beforeEach(() => {
		tracker = new PendingSetupTracker()
	})

	it('初始状态无 pending setup', () => {
		expect(tracker._pendingSetups.size).toBe(0)
	})

	it('beginSetup 后 Map 中存在对应 moduleId', () => {
		tracker.beginSetup('mod-A')
		expect(tracker._pendingSetups.has('mod-A')).toBe(true)
	})

	it('completeSetup 后从 Map 中移除', () => {
		const resolve = tracker.beginSetup('mod-A')
		tracker.completeSetup('mod-A', resolve)
		expect(tracker._pendingSetups.has('mod-A')).toBe(false)
	})

	it('无 pending 时 waitForPendingExcept 立即 resolve', async () => {
		const done = vi.fn()
		await tracker.waitForPendingExcept('any-id').then(done)
		expect(done).toHaveBeenCalledOnce()
	})

	it('pending 完成后 waitForPendingExcept resolve', async () => {
		const resolve = tracker.beginSetup('mod-A')
		const done = vi.fn()
		const p = tracker.waitForPendingExcept('other-id').then(done)

		expect(done).not.toHaveBeenCalled()
		tracker.completeSetup('mod-A', resolve)
		await p
		expect(done).toHaveBeenCalledOnce()
	})

	it('excludeModuleId 的 pending 不阻塞 waitForPendingExcept', async () => {
		// mod-self 是调用方自身，mod-child 是子组件
		const resolveSelf = tracker.beginSetup('mod-self')
		const resolveChild = tracker.beginSetup('mod-child')

		const done = vi.fn()
		// 排除自身，只等 child
		const p = tracker.waitForPendingExcept('mod-self').then(done)

		// child 完成后应 resolve，即使 self 还 pending
		tracker.completeSetup('mod-child', resolveChild)
		await p
		expect(done).toHaveBeenCalledOnce()

		// 清理
		tracker.completeSetup('mod-self', resolveSelf)
	})
})

describe('竞态场景：IntersectionObserver 与子组件 created 的时序', () => {
	let tracker
	let eventBus
	let observerLog

	beforeEach(() => {
		tracker = new PendingSetupTracker()
		eventBus = createEventBus()
		observerLog = []
	})

	async function simulateAddObserver(callerModuleId) {
		// DOM 出现后，等待（排除自身的）pending setup 完成
		await tracker.waitForPendingExcept(callerModuleId)
		// 建立 observer，触发首次回调
		const listenerReady = eventBus.has('needFeedBack')
		observerLog.push({ listenerReady })
		eventBus.emit('needFeedBack')
	}

	it('【复现竞态】不等待：observer 触发时 EventBus 监听尚未注册', async () => {
		const resolve = tracker.beginSetup('sliding-scale')

		// 不等待，直接触发（旧 setTimeout 可能的竞态）
		observerLog.push({ listenerReady: eventBus.has('needFeedBack') })
		eventBus.emit('needFeedBack')

		await new Promise(r => setTimeout(r, 0))
		eventBus.once('needFeedBack', () => {})
		tracker.completeSetup('sliding-scale', resolve)

		expect(observerLog[0].listenerReady).toBe(false)
	})

	it('【验证修复】等待 pending setup（排除自身）：触发时监听已注册', async () => {
		const setupPromise = simulateComponentSetup(tracker, 'sliding-scale', eventBus, 0)
		const observerPromise = simulateAddObserver('index-parent')

		await Promise.all([setupPromise, observerPromise])
		expect(observerLog[0].listenerReady).toBe(true)
	})

	it('created 有耗时时也保证顺序', async () => {
		const setupPromise = simulateComponentSetup(tracker, 'sliding-scale', eventBus, 10)
		const observerPromise = simulateAddObserver('index-parent')

		await Promise.all([setupPromise, observerPromise])
		expect(observerLog[0].listenerReady).toBe(true)
	})

	it('多个子组件同时初始化：全部完成后 observer 才触发', async () => {
		const s1 = simulateComponentSetup(tracker, 'child-1', eventBus, 5)
		const s2 = simulateComponentSetup(tracker, 'child-2', eventBus, 10)
		const obs = simulateAddObserver('index-parent')

		await Promise.all([s1, s2, obs])
		expect(observerLog[0].listenerReady).toBe(true)
	})

	it('【关键】demo 场景：onLoad 内调用 observer，调用方自身是 pending —— 不死锁', async () => {
		/**
		 * 模拟 Page onLoad 场景：
		 *   页面 moduleId = 'page-A'，onLoad 内调用 createIntersectionObserver
		 *   此时页面自身在 #invokeInitLifecycle 中（pending），
		 *   若不排除自身，waitForPendingExcept 会等自身完成 → 死锁
		 *   正确：排除自身后，无其他 pending，立即 resolve
		 */
		const resolvePage = tracker.beginSetup('page-A')

		// 页面 onLoad 内触发 addObserver（排除自身 page-A）
		const done = vi.fn()
		const obsPromise = tracker.waitForPendingExcept('page-A').then(done)

		// 没有其他 pending，应立即 resolve
		await obsPromise
		expect(done).toHaveBeenCalledOnce()

		// 清理
		tracker.completeSetup('page-A', resolvePage)
	})

	it('【关键】二次打开场景：addObserver 到达时 pendingSetupCount=0，DOM 出现后子组件 setup 才开始', async () => {
		/**
		 * 二次打开时：
		 *   1. addIntersectionObserver 请求到达，_pendingSetups 为空（上次已全部完成）
		 *   2. waitForElement 等待 .good-weight DOM（因 show=false→true，wx:if 重建）
		 *   3. DOM 出现时 sliding-scale 的 setup 发 mC，beginSetup 记录到 pending
		 *   4. waitForPendingExcept('index-parent') 等到 child setup 完成
		 *   5. created/attached 已执行，EventBus 监听已注册
		 */

		// 模拟 DOM 出现时子组件 setup 才开始（异步）
		let childResolve
		const childSetupStarted = new Promise((r) => {
			setTimeout(() => {
				childResolve = tracker.beginSetup('sliding-scale-new')
				eventBus.once('needFeedBack', () => {})
				r()
			}, 5)
		})

		// 等 DOM 出现（childSetupStarted）
		await childSetupStarted
		// child setup 完成
		tracker.completeSetup('sliding-scale-new', childResolve)

		// 此时 waitForPendingExcept（已无 pending）应立即通过
		const done = vi.fn()
		await tracker.waitForPendingExcept('index-parent').then(done)
		expect(done).toHaveBeenCalledOnce()
		expect(eventBus.has('needFeedBack')).toBe(true)
	})
})

describe('边界情况', () => {
	let tracker

	beforeEach(() => {
		tracker = new PendingSetupTracker()
	})

	it('多次 beginSetup/completeSetup 后 Map 为空', () => {
		const r1 = tracker.beginSetup('a')
		const r2 = tracker.beginSetup('b')
		tracker.completeSetup('a', r1)
		tracker.completeSetup('b', r2)
		expect(tracker._pendingSetups.size).toBe(0)
	})

	it('同一 moduleId 重复 beginSetup（组件重建场景）', async () => {
		const r1 = tracker.beginSetup('mod-x')
		tracker.completeSetup('mod-x', r1)

		// 组件销毁后重新挂载
		const r2 = tracker.beginSetup('mod-x')
		const done = vi.fn()
		const p = tracker.waitForPendingExcept('other').then(done)

		tracker.completeSetup('mod-x', r2)
		await p
		expect(done).toHaveBeenCalledOnce()
	})

	it('excludeModuleId 不在 pending 中时不影响等待', async () => {
		const r = tracker.beginSetup('mod-A')
		const done = vi.fn()
		// 排除一个不存在的 id
		const p = tracker.waitForPendingExcept('nonexistent').then(done)

		tracker.completeSetup('mod-A', r)
		await p
		expect(done).toHaveBeenCalledOnce()
	})
})
