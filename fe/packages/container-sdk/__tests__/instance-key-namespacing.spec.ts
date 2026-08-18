import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createContainer } from '../src/index.js'
import { resetFakeWorker } from './fixtures/fake-worker.js'
import { installFetchMock } from './fixtures/mock-fetch.js'

// 回归测试：内置 QueryRouter 缺省 urlSync: true 时无条件写 ?appId=&entry=&page=
// 到地址栏。同一页面上两个 createContainer() 若都用默认 urlSync: true，会写到
// 完全相同的 key，互相覆盖对方的路由（与 multi-instance-isolation.spec.ts 覆盖
// 的模块级状态串台是同构问题，只是这里是地址栏这个全局单例资源）。
//
// 修复：createContainer({ instanceKey }) 可选字符串，内置 QueryRouter 的 query key
// 按 `${baseKey}__${instanceKey}` 命名空间化（如 'hostA' 把 appId 变成 appId__hostA），
// 两个不同 instanceKey 的容器都用默认 urlSync: true 也不再互相覆盖。
// 不传 instanceKey 时必须与该特性存在之前逐字节一致：plain appId/entry/page，
// 不出现任何 __ 后缀，对既有单容器宿主零行为变化。

describe('createContainer({ instanceKey }) namespaces the built-in QueryRouter address-bar keys', () => {
	let mountA: HTMLElement
	let mountB: HTMLElement

	beforeEach(() => {
		installFetchMock()
		resetFakeWorker()
		mountA = document.createElement('div')
		mountB = document.createElement('div')
		document.body.appendChild(mountA)
		document.body.appendChild(mountB)
		// jsdom's window.location is shared across tests within this file; other specs
		// in this suite only assert specific known keys (immune to leftover params from
		// earlier tests), but the backward-compat pin below asserts the whole search
		// string contains no "__" anywhere, so it needs a clean slate per test.
		window.history.replaceState(null, '', window.location.pathname)
	})

	it('two containers with distinct instanceKeys both default urlSync:true without colliding', async () => {
		const containerA = createContainer({ mount: mountA, instanceKey: 'hostA' })
		const containerB = createContainer({ mount: mountB, instanceKey: 'hostB' })

		await containerA.openApp({ appId: 'wx-instance-key-a', path: 'pages/index/index' })
		await containerB.openApp({ appId: 'wx-instance-key-b', path: 'pages/index/index' })

		await vi.waitFor(() => {
			const params = new URLSearchParams(window.location.search)
			expect(params.get('appId__hostA')).toBe('wx-instance-key-a')
			expect(params.get('appId__hostB')).toBe('wx-instance-key-b')
		}, { timeout: 8000 })

		// 两者必须同时在场——不是后一个覆盖了前一个又恰好读到了正确值。
		const params = new URLSearchParams(window.location.search)
		expect(params.get('appId__hostA')).toBe('wx-instance-key-a')
		expect(params.get('appId__hostB')).toBe('wx-instance-key-b')
	}, 10000)

	it('closing container A\'s only app only removes A\'s namespaced keys, leaving B\'s untouched', async () => {
		const containerA = createContainer({ mount: mountA, instanceKey: 'hostA' })
		const containerB = createContainer({ mount: mountB, instanceKey: 'hostB' })

		await containerA.openApp({ appId: 'wx-instance-key-close-a', path: 'pages/index/index' })
		await containerB.openApp({ appId: 'wx-instance-key-close-b', path: 'pages/index/index' })

		await vi.waitFor(() => {
			const params = new URLSearchParams(window.location.search)
			expect(params.get('appId__hostA')).toBe('wx-instance-key-close-a')
			expect(params.get('appId__hostB')).toBe('wx-instance-key-close-b')
		}, { timeout: 8000 })

		containerA.closeApp()

		await vi.waitFor(() => {
			const params = new URLSearchParams(window.location.search)
			expect(params.get('appId__hostA')).toBeNull()
		}, { timeout: 8000 })

		const params = new URLSearchParams(window.location.search)
		expect(params.get('entry__hostA')).toBeNull()
		expect(params.get('page__hostA')).toBeNull()
		// 兄弟容器 B 的命名空间 key 完全不受影响
		expect(params.get('appId__hostB')).toBe('wx-instance-key-close-b')
	}, 10000)

	it('backward-compat pin: omitting instanceKey still writes plain appId/entry/page with no __ suffix anywhere', async () => {
		const container = createContainer({ mount: mountA })

		await container.openApp({ appId: 'wx-instance-key-omitted', path: 'pages/index/index' })

		await vi.waitFor(() => {
			expect(new URLSearchParams(window.location.search).get('appId')).toBe('wx-instance-key-omitted')
		}, { timeout: 8000 })

		expect(window.location.search).not.toContain('__')
		const params = new URLSearchParams(window.location.search)
		expect(params.get('appId')).toBe('wx-instance-key-omitted')
		expect(params.has('entry')).toBe(true)
		expect(params.has('page')).toBe(true)
	}, 10000)
})
