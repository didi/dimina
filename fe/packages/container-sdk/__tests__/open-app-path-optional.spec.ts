import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createContainer } from '../src/index.js'
import { FakeWorker, resetFakeWorker } from './fixtures/fake-worker.js'
import { installFetchMock } from './fixtures/mock-fetch.js'

// 契约：openApp({ appId, restoreStack }) 可以省略 path —— 宿主刷新恢复时手里只有
// QueryRouter.parse() 给出的 { appId, stack }，不该再自己把 stack[0] 拼回 "pagePath?query"
// 字符串。restoreStack[0] 就是入口页；path 仍在时按旧行为优先；两者都没有时读取
// app-config.json 的 entryPagePath（小游戏由此使用 game 入口）。
//
// 断言面：openApp resolve 出的 miniApp 上的 appId / pagePath / query 字段（不是拼出来的
// URL 字符串），这三者就是宿主接下来渲染地址栏、做前端路由要用的东西。

describe('openApp path optional when restoreStack is provided', () => {
	let mount: HTMLElement

	beforeEach(() => {
		resetFakeWorker()
		mount = document.createElement('div')
		document.body.appendChild(mount)
	})

	async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
		try {
			await promise
		}
		catch (error) {
			return error as Error
		}
		throw new Error('expected openApp() to reject, but it resolved')
	}

	it('derives the entry page (pagePath + query) from restoreStack[0] when path is omitted', async () => {
		installFetchMock()
		const container = createContainer({ mount })

		const miniApp = await container.openApp({
			appId: 'wx-restore-basic',
			restoreStack: [
				{ pagePath: 'pages/index/index', query: { id: '42', from: 'share' } },
			],
		})

		expect(miniApp.appId).toBe('wx-restore-basic')
		expect(miniApp.pagePath).toBe('pages/index/index')
		expect(miniApp.query).toEqual({ id: '42', from: 'share' })
	}, 10000)

	it('preserves restoreStack[0].query values with special characters (=, &, unicode, spaces) verbatim, without re-encoding', async () => {
		installFetchMock()
		const container = createContainer({ mount })

		const specialQuery = {
			'a=b': 'x&y=z',
			'商品 id': '手机 壳 & 配件',
		}

		const miniApp = await container.openApp({
			appId: 'wx-restore-special-query',
			restoreStack: [
				{ pagePath: 'pages/index/index', query: specialQuery },
			],
		})

		// 对象直传：key/value 里的 '=', '&', 中文、空格都必须原样保留，
		// 不能先拼成 "pagePath?a=b&..." 字符串再重新 parse 一遍（那样会把 query 切碎/错位）。
		expect(miniApp.query).toEqual(specialQuery)

		// 佐证：这份 query 确实以未受损的形式送到了逻辑线程，而不是只在容器侧的
		// resolve 值上"看起来对"。
		await vi.waitFor(() => {
			const sawValue = FakeWorker.instances.some(worker =>
				worker.postMessage.mock.calls.some(([message]: [unknown]) =>
					JSON.stringify(message).includes('手机 壳 & 配件')))
			expect(sawValue).toBe(true)
		}, { timeout: 8000 })
	}, 10000)

	it('lets path win over restoreStack for the entry page when both are provided (backward compatible)', async () => {
		installFetchMock()
		const container = createContainer({ mount })

		const miniApp = await container.openApp({
			appId: 'wx-path-wins',
			path: 'pages/index/index?keep=fromPath',
			restoreStack: [
				{ pagePath: 'pages/other/other', query: { should: 'not-appear' } },
			],
		})

		expect(miniApp.pagePath).toBe('pages/index/index')
		expect(miniApp.query).toEqual({ keep: 'fromPath' })
	}, 10000)

	it('uses app-config entryPagePath when neither path nor restoreStack is provided', async () => {
		installFetchMock()
		const container = createContainer({ mount })

		const miniApp = await container.openApp({ appId: 'wx-missing-both' })
		await vi.waitFor(() => expect(miniApp.pagePath).toBe('pages/index/index'))
	}, 10000)

	it('detects a mini game from app-config and launches its game entry', async () => {
		const gameConfig = {
			app: {
				runtimeType: 'game',
				entryPagePath: 'game',
				pages: ['game'],
				window: { navigationStyle: 'custom' },
			},
			modules: {},
		}
		globalThis.fetch = vi.fn(() => Promise.resolve({
			ok: true,
			status: 200,
			text: () => Promise.resolve(JSON.stringify(gameConfig)),
		})) as typeof fetch
		const container = createContainer({ mount })

		const miniApp = await container.openApp({ appId: 'wx-game' })
		await vi.waitFor(() => {
			expect(miniApp.runtimeType).toBe('game')
			expect(miniApp.pagePath).toBe('game')
			expect(miniApp.el.classList.contains('dimina-native-view--game')).toBe(true)
			const loadMessage = FakeWorker.instances
				.flatMap(worker => worker.postMessage.mock.calls)
				.map(([message]) => message)
				.find(message => message?.type === 'loadResource')
			expect(loadMessage?.body).toMatchObject({
				appId: 'wx-game',
				pagePath: 'game',
				runtimeType: 'game',
			})
		}, { timeout: 8000 })
	}, 10000)

	it('uses app-config entryPagePath when restoreStack is empty and path is omitted', async () => {
		installFetchMock()
		const container = createContainer({ mount })

		const miniApp = await container.openApp({ appId: 'wx-empty-stack', restoreStack: [] })
		await vi.waitFor(() => expect(miniApp.pagePath).toBe('pages/index/index'))
	}, 10000)

	it('rejects when restoreStack[0].pagePath is empty and path is omitted', async () => {
		installFetchMock()
		const container = createContainer({ mount })

		const error = await rejectionOf(container.openApp({
			appId: 'wx-empty-page-path',
			restoreStack: [{ pagePath: '' }],
		}))

		expect(error).toBeInstanceOf(Error)
		expect(error.message.startsWith('[container]')).toBe(true)
		expect(error.message).toMatch(/path/i)
	}, 10000)
})
