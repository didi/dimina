import { beforeEach, describe, expect, it } from 'vitest'
import { createContainer } from '../src/index.js'
import { installFetchMock } from './fixtures/mock-fetch.js'

// 契约行为 2：createContainer({apiNamespaces}) 要贯通到每个打开的小程序的
// getApiNamespaces()（去重、不破坏内建 wx/dd 语义）；不传时行为与现状一致。
describe('createContainer apiNamespaces passthrough', () => {
	let mount: HTMLElement

	beforeEach(() => {
		installFetchMock()
		mount = document.createElement('div')
		document.body.appendChild(mount)
	})

	it('exposes the injected apiNamespaces on the opened miniApp', async () => {
		const container = createContainer({ mount, apiNamespaces: ['qd'] })

		const miniApp = await container.openApp({ appId: 'wx-ns', path: 'pages/index/index' })

		expect(typeof miniApp.getApiNamespaces).toBe('function')
		expect(miniApp.getApiNamespaces()).toContain('qd')
	}, 10000)

	it('falls back to built-in namespaces when apiNamespaces is not provided', async () => {
		const container = createContainer({ mount })

		const miniApp = await container.openApp({ appId: 'wx-ns-default', path: 'pages/index/index' })

		const namespaces = miniApp.getApiNamespaces()
		expect(Array.isArray(namespaces)).toBe(true)
		expect(namespaces).not.toContain('qd')
	}, 10000)

	it('deduplicates apiNamespaces across repeated entries', async () => {
		const container = createContainer({ mount, apiNamespaces: ['qd', 'qd'] })

		const miniApp = await container.openApp({ appId: 'wx-ns-dedupe', path: 'pages/index/index' })

		const namespaces = miniApp.getApiNamespaces()
		const qdCount = namespaces.filter(ns => ns === 'qd').length
		expect(qdCount).toBe(1)
	}, 10000)
})
