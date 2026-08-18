import { beforeEach, describe, expect, it } from 'vitest'
import { createContainer } from '../src/index.js'
import { installFetchMock } from './fixtures/mock-fetch.js'

// 契约行为 1：不调用 setRootView，容器也要能正常 openApp/closeApp（空栈安全）。
// 这条专抓"SDK 把根视图当成必需前置条件"的回归——现状 container 里 Application 总是
// 先 initRootView(AppList 页) 再 openApp，SDK 必须去掉这个隐性依赖。
describe('container without a root view', () => {
	let mount: HTMLElement

	beforeEach(() => {
		installFetchMock()
		mount = document.createElement('div')
		document.body.appendChild(mount)
	})

	it('opens an app without calling setRootView and mounts a view under mount', async () => {
		const container = createContainer({ mount })

		const miniApp = await container.openApp({ appId: 'wx-no-root', path: 'pages/index/index' })

		expect(miniApp).toBeTruthy()
		expect(mount.childElementCount).toBeGreaterThan(0)
	}, 10000)

	it('closes the app without throwing even though no root view was ever set', async () => {
		const container = createContainer({ mount })
		await container.openApp({ appId: 'wx-no-root', path: 'pages/index/index' })

		expect(() => container.closeApp()).not.toThrow()
	}, 10000)
})
