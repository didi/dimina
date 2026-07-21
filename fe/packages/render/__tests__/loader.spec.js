import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('../src/core/message', () => ({
	default: { invoke },
}))

import loader from '../src/core/loader'

describe('render resource loader', () => {
	beforeEach(() => {
		invoke.mockReset()
		window.modRequire = vi.fn()
		loader.staticModules = {}
		vi.restoreAllMocks()
	})

	it('loads a declared placeholder when the target component module is unavailable', () => {
		window.modRequire.mockImplementation((modulePath) => {
			if (modulePath === '/components/async-card') {
				throw new Error(`module ${modulePath} not found`)
			}
		})

		loader.createModule({
			path: '/components/shell',
			usingComponents: {
				'async-card': '/components/async-card',
				'loading-card': '/components/loading-card',
			},
			componentPlaceholder: {
				'async-card': 'loading-card',
			},
		})

		expect(window.modRequire).toHaveBeenCalledWith('/components/async-card')
		expect(window.modRequire).toHaveBeenCalledWith('/components/loading-card')
		expect(loader.getModuleByPath('/components/shell')).toBeDefined()
	})

	it('reports loaded only after every resource and the page module succeed', async () => {
		vi.spyOn(document.head, 'append').mockImplementation((element) => {
			queueMicrotask(() => element.onload())
			return element
		})

		await expect(loader.loadResource({
			bridgeId: 'bridge-success',
			appId: 'app',
			pagePath: 'pages/index/index',
			root: 'main',
			baseUrl: '/',
		})).resolves.toBe(true)

		expect(window.modRequire).toHaveBeenCalledWith('pages/index/index')
		expect(invoke).toHaveBeenCalledWith({
			type: 'renderResourceLoaded',
			target: 'service',
			body: { bridgeId: 'bridge-success' },
		})
	})

	it('reports a failure and never evaluates or acknowledges an incomplete page', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {})
		vi.spyOn(document.head, 'append').mockImplementation((element) => {
			queueMicrotask(() => {
				if (element.tagName === 'SCRIPT') {
					element.onerror()
				}
				else {
					element.onload()
				}
			})
			return element
		})

		await expect(loader.loadResource({
			bridgeId: 'bridge-failure',
			appId: 'app',
			pagePath: 'pages/index/index',
			root: 'main',
			baseUrl: '/',
		})).resolves.toBe(false)

		expect(window.modRequire).not.toHaveBeenCalled()
		expect(invoke).toHaveBeenCalledWith(expect.objectContaining({
			type: 'renderResourceLoadFailed',
			target: 'service',
			body: expect.objectContaining({
				bridgeId: 'bridge-failure',
				pagePath: 'pages/index/index',
				errors: [expect.stringContaining('脚本文件加载失败')],
			}),
		}))
		expect(invoke).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'renderResourceLoaded' }))
	})

	it('reports module evaluation failures without acknowledging the page', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {})
		vi.spyOn(document.head, 'append').mockImplementation((element) => {
			queueMicrotask(() => element.onload())
			return element
		})
		window.modRequire.mockImplementation(() => {
			throw new Error('module evaluation failed')
		})

		await expect(loader.loadResource({
			bridgeId: 'bridge-module-failure',
			appId: 'app',
			pagePath: 'pages/index/index',
			root: 'main',
			baseUrl: '/',
		})).resolves.toBe(false)

		expect(invoke).toHaveBeenCalledWith(expect.objectContaining({
			type: 'renderResourceLoadFailed',
			body: expect.objectContaining({ errors: ['module evaluation failed'] }),
		}))
		expect(invoke).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'renderResourceLoaded' }))
	})
})
