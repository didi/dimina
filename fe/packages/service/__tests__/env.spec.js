import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock all heavy dependencies — we only care about the namespace logic
const mockGlobalApi = { __mock: true }

vi.mock('@dimina/common', () => ({
	modDefine: vi.fn(),
	modRequire: vi.fn(),
}))
vi.mock('../src/api', () => ({ default: mockGlobalApi }))
vi.mock('../src/instance/component/component-module', () => ({ ComponentModule: { type: 'component' } }))
vi.mock('../src/instance/page/page-module', () => ({ PageModule: { type: 'page' } }))
vi.mock('../src/core/loader', () => ({ default: { createAppModule: vi.fn(), createModule: vi.fn() } }))
vi.mock('../src/core/router', () => ({ default: { stack: vi.fn(() => []) } }))
vi.mock('../src/core/runtime', () => ({ default: { app: null } }))

describe('env.js API namespace registration', () => {
	beforeEach(() => {
		// Clean up namespace-related globals before each test
		delete globalThis.__diminaApiNamespaces
		delete globalThis.qd
		delete globalThis.myapp
		delete globalThis.dd
		delete globalThis.wx
		// Simulate Worker's self (not available in Node)
		globalThis.self = { name: '' }
	})

	afterEach(() => {
		vi.resetModules()
	})

	it('should set dd and wx to globalApi', async () => {
		await import('../src/core/env.js')

		expect(globalThis.dd).toBe(mockGlobalApi)
		expect(globalThis.wx).toBe(mockGlobalApi)
	})

	it('should register namespaces from __diminaApiNamespaces', async () => {
		globalThis.__diminaApiNamespaces = ['qd', 'myapp']

		await import('../src/core/env.js')

		expect(globalThis.qd).toBe(mockGlobalApi)
		expect(globalThis.myapp).toBe(mockGlobalApi)
		// dd and wx should still work
		expect(globalThis.dd).toBe(mockGlobalApi)
		expect(globalThis.wx).toBe(mockGlobalApi)
	})

	it('should not create extra globals when __diminaApiNamespaces is empty', async () => {
		globalThis.__diminaApiNamespaces = []

		await import('../src/core/env.js')

		expect(globalThis.qd).toBeUndefined()
	})

	it('should fall back to self.name when __diminaApiNamespaces is not set', async () => {
		globalThis.name = JSON.stringify({ apiNamespaces: ['qd'] })

		await import('../src/core/env.js')

		expect(globalThis.qd).toBe(mockGlobalApi)
	})

	it('should ignore invalid JSON in globalThis.name', async () => {
		globalThis.name = 'not-json'

		await import('../src/core/env.js')

		expect(globalThis.qd).toBeUndefined()
		// Core globals should still work
		expect(globalThis.wx).toBe(mockGlobalApi)
	})

	it('should prefer __diminaApiNamespaces over self.name', async () => {
		globalThis.__diminaApiNamespaces = ['qd']
		globalThis.name = JSON.stringify({ apiNamespaces: ['myapp'] })

		await import('../src/core/env.js')

		expect(globalThis.qd).toBe(mockGlobalApi)
		expect(globalThis.myapp).toBeUndefined()
	})
})
