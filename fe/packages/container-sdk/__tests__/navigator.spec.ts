import type { Bridge } from '../src/core/bridge.js'
import { describe, expect, it } from 'vitest'
import { Navigator } from '../src/pages/miniApp/navigator.js'

// Navigator 是从 2800 行 MiniApp 类里抽出来的页面栈/tab 池记账权威。
// 这里只用 { opts: { pagePath, query } } 形状的假对象站位 Bridge——
// 真实 Bridge 构造依赖 jscore/webview 等重量级运行时，Navigator 的契约
// 完全不关心这些，只关心引用身份与 opts 读取。
function fakeBridge(pagePath: string, query?: Record<string, string>): Bridge {
	return {
		id: `bridge_${Math.random().toString(36).slice(2)}`,
		opts: { pagePath, query },
	} as unknown as Bridge
}

describe('Navigator', () => {
	describe('empty state', () => {
		it('reports empty top/size/getStack/getPageStack before any push', () => {
			const nav = new Navigator()

			expect(nav.top).toBeUndefined()
			expect(nav.size).toBe(0)
			expect(nav.getStack()).toEqual([])
			expect(nav.getPageStack()).toEqual([])
		})
	})

	describe('primary stack', () => {
		it('pushPage appends to the top and preserves push order', () => {
			const nav = new Navigator()
			const a = fakeBridge('pages/a/a')
			const b = fakeBridge('pages/b/b')
			const c = fakeBridge('pages/c/c')

			nav.pushPage(a)
			nav.pushPage(b)
			nav.pushPage(c)

			expect(nav.top).toBe(c)
			expect(nav.size).toBe(3)
			expect(nav.getStack()).toEqual([a, b, c])
		})

		it('getStack returns a defensive copy that does not leak mutations back into internal state', () => {
			const nav = new Navigator()
			const a = fakeBridge('pages/a/a')
			const b = fakeBridge('pages/b/b')
			nav.pushPage(a)
			nav.pushPage(b)

			const copy = nav.getStack()
			copy.pop()
			copy.push(fakeBridge('pages/injected/injected'))

			// 外部对返回数组的增删不得反映到 Navigator 内部状态。
			expect(nav.size).toBe(2)
			expect(nav.top).toBe(b)
			expect(nav.getStack()).toEqual([a, b])
		})

		it('popPage removes and returns the top bridge, and updates top/size', () => {
			const nav = new Navigator()
			const a = fakeBridge('pages/a/a')
			const b = fakeBridge('pages/b/b')
			nav.pushPage(a)
			nav.pushPage(b)

			const popped = nav.popPage()

			expect(popped).toBe(b)
			expect(nav.top).toBe(a)
			expect(nav.size).toBe(1)
			expect(nav.getStack()).toEqual([a])
		})

		it('popPage on an empty stack returns undefined without throwing', () => {
			const nav = new Navigator()

			expect(() => {
				const result = nav.popPage()
				expect(result).toBeUndefined()
			}).not.toThrow()
			expect(nav.size).toBe(0)
			expect(nav.top).toBeUndefined()
		})

		it('removeFromStack removes a bridge from the middle and preserves relative order of the rest', () => {
			const nav = new Navigator()
			const a = fakeBridge('pages/a/a')
			const b = fakeBridge('pages/b/b')
			const c = fakeBridge('pages/c/c')
			nav.pushPage(a)
			nav.pushPage(b)
			nav.pushPage(c)

			const removed = nav.removeFromStack(b)

			expect(removed).toBe(true)
			expect(nav.getStack()).toEqual([a, c])
			expect(nav.top).toBe(c)
			expect(nav.size).toBe(2)
		})

		it('removeFromStack on an already-removed bridge returns false and does not corrupt the stack', () => {
			const nav = new Navigator()
			const a = fakeBridge('pages/a/a')
			const b = fakeBridge('pages/b/b')
			nav.pushPage(a)
			nav.pushPage(b)

			expect(nav.removeFromStack(b)).toBe(true)
			expect(nav.removeFromStack(b)).toBe(false)

			expect(nav.getStack()).toEqual([a])
			expect(nav.size).toBe(1)
			expect(nav.top).toBe(a)
		})
	})

	describe('resetTo', () => {
		it('tears down the entire stack, the tab pool and activeTabPath, leaving only the new bridge', () => {
			const nav = new Navigator()
			const a = fakeBridge('pages/a/a')
			const b = fakeBridge('pages/b/b')
			nav.pushPage(a)
			nav.pushPage(b)

			const tabA = fakeBridge('pages/tab-a/tab-a')
			const tabB = fakeBridge('pages/tab-b/tab-b')
			nav.setTabBridge('pages/tab-a/tab-a', tabA)
			nav.setTabBridge('pages/tab-b/tab-b', tabB)
			nav.setActiveTabPath('pages/tab-a/tab-a')

			const fresh = fakeBridge('pages/fresh/fresh')
			nav.resetTo(fresh)

			expect(nav.size).toBe(1)
			expect(nav.top).toBe(fresh)
			expect(nav.getStack()).toEqual([fresh])
			expect(nav.getTabBridge('pages/tab-a/tab-a')).toBeUndefined()
			expect(nav.getTabBridge('pages/tab-b/tab-b')).toBeUndefined()
			expect(nav.activeTabPath).toBeNull()
		})
	})

	describe('clear', () => {
		it('empties the stack, the tab pool and activeTabPath without pushing any replacement', () => {
			const nav = new Navigator()
			const a = fakeBridge('pages/a/a')
			const b = fakeBridge('pages/b/b')
			nav.pushPage(a)
			nav.pushPage(b)

			const tabA = fakeBridge('pages/tab-a/tab-a')
			const tabB = fakeBridge('pages/tab-b/tab-b')
			nav.setTabBridge('pages/tab-a/tab-a', tabA)
			nav.setTabBridge('pages/tab-b/tab-b', tabB)
			nav.setActiveTabPath('pages/tab-a/tab-a')

			nav.clear()

			expect(nav.size).toBe(0)
			expect(nav.top).toBeUndefined()
			expect(nav.getStack()).toEqual([])
			expect(nav.getTabBridge('pages/tab-a/tab-a')).toBeUndefined()
			expect(nav.getTabBridge('pages/tab-b/tab-b')).toBeUndefined()
			expect(nav.activeTabPath).toBeNull()
		})
	})

	describe('tab pool', () => {
		it('round-trips distinct pagePath keys independently via setTabBridge/getTabBridge/deleteTabBridge', () => {
			const nav = new Navigator()
			const tabA = fakeBridge('pages/tab-a/tab-a')
			const tabB = fakeBridge('pages/tab-b/tab-b')

			nav.setTabBridge('pages/tab-a/tab-a', tabA)
			nav.setTabBridge('pages/tab-b/tab-b', tabB)

			expect(nav.getTabBridge('pages/tab-a/tab-a')).toBe(tabA)
			expect(nav.getTabBridge('pages/tab-b/tab-b')).toBe(tabB)

			nav.deleteTabBridge('pages/tab-a/tab-a')

			expect(nav.getTabBridge('pages/tab-a/tab-a')).toBeUndefined()
			// 删除一个 key 不得影响其它 key。
			expect(nav.getTabBridge('pages/tab-b/tab-b')).toBe(tabB)
		})

		it('getTabBridge returns undefined for a path that was never set', () => {
			const nav = new Navigator()

			expect(nav.getTabBridge('pages/never-set/never-set')).toBeUndefined()
		})

		it('getTabBridges returns all pooled bridges regardless of key, independent of the primary stack', () => {
			const nav = new Navigator()
			const a = fakeBridge('pages/a/a')
			nav.pushPage(a)

			const tabA = fakeBridge('pages/tab-a/tab-a')
			const tabB = fakeBridge('pages/tab-b/tab-b')
			nav.setTabBridge('pages/tab-a/tab-a', tabA)
			nav.setTabBridge('pages/tab-b/tab-b', tabB)

			expect(nav.getTabBridges()).toEqual([tabA, tabB])
		})

		it('getTabBridges returns an empty array when the tab pool is empty', () => {
			const nav = new Navigator()

			expect(nav.getTabBridges()).toEqual([])
		})

		it('activeTabPath getter/setter round-trips, including explicitly resetting back to null', () => {
			const nav = new Navigator()

			expect(nav.activeTabPath).toBeNull()

			nav.setActiveTabPath('pages/tab-a/tab-a')
			expect(nav.activeTabPath).toBe('pages/tab-a/tab-a')

			nav.setActiveTabPath('pages/tab-b/tab-b')
			expect(nav.activeTabPath).toBe('pages/tab-b/tab-b')

			nav.setActiveTabPath(null)
			expect(nav.activeTabPath).toBeNull()
		})
	})

	describe('getPageStack', () => {
		it('maps the primary stack (not the tab pool) to pagePath/query entries, stripping a leading slash and defaulting missing query to {}', () => {
			const nav = new Navigator()
			const a = fakeBridge('/pages/a/a', { x: '1' })
			const b = fakeBridge('pages/b/b', undefined)

			// 往 tab 池里塞一个不同的 bridge，证明 getPageStack 只读主栈，不受 tab 池干扰。
			nav.setTabBridge('pages/tab-only/tab-only', fakeBridge('pages/tab-only/tab-only', { z: '9' }))

			nav.pushPage(a)
			nav.pushPage(b)

			expect(nav.getPageStack()).toEqual([
				{ pagePath: 'pages/a/a', query: { x: '1' } },
				{ pagePath: 'pages/b/b', query: {} },
			])
		})

		it('returns an empty array when the stack is empty even if the tab pool is populated', () => {
			const nav = new Navigator()
			nav.setTabBridge('pages/tab-a/tab-a', fakeBridge('pages/tab-a/tab-a'))

			expect(nav.getPageStack()).toEqual([])
		})
	})
})
