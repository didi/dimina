import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock all heavy dependencies — we only care about the namespace logic
const mockGlobalApi = { __mock: true }
// registerEnumerableApiNames is a named export of ../src/api; mock it here so
// env.js can import it, and so we can assert env.init() forwards the
// registeredApis list to it.
const mockRegisterEnumerableApiNames = vi.fn()

vi.mock('@dimina/common', () => ({
	modDefine: vi.fn(),
	modRequire: vi.fn(),
}))
vi.mock('../src/api', () => ({
	default: mockGlobalApi,
	registerEnumerableApiNames: mockRegisterEnumerableApiNames,
}))
vi.mock('../src/instance/component/component-module', () => ({ ComponentModule: { type: 'component' } }))
vi.mock('../src/instance/page/page-module', () => ({ PageModule: { type: 'page' } }))
vi.mock('../src/core/loader', () => ({ default: { createAppModule: vi.fn(), createModule: vi.fn() } }))
vi.mock('../src/core/router', () => ({ default: { stack: vi.fn(() => []) } }))
vi.mock('../src/core/runtime', () => ({ default: { app: null } }))

describe('env.js API namespace registration', () => {
	beforeEach(() => {
		// Clean up namespace-related globals before each test
		delete globalThis.__diminaApiNamespaces
		delete globalThis.__diminaRegisteredApis
		delete globalThis.qd
		delete globalThis.myapp
		delete globalThis.dd
		delete globalThis.wx
		// Simulate Worker's self (not available in Node)
		globalThis.self = { name: '' }
		mockRegisterEnumerableApiNames.mockClear()
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

// ---------------------------------------------------------------------------
// Tests for the registeredApis → registerEnumerableApiNames forwarding: env.js
// reads __diminaRegisteredApis / globalThis.name.registeredApis and calls
// registerEnumerableApiNames with the result.
// ---------------------------------------------------------------------------
describe('env.js registeredApis → registerEnumerableApiNames forwarding', () => {
	beforeEach(() => {
		delete globalThis.__diminaRegisteredApis
		delete globalThis.__diminaApiNamespaces
		delete globalThis.name
		globalThis.self = { name: '' }
		mockRegisterEnumerableApiNames.mockClear()
	})

	afterEach(() => {
		vi.resetModules()
	})

	// -----------------------------------------------------------------------
	// Bug caught: env.js never reads __diminaRegisteredApis, so custom APIs
	// injected by the host container are never made enumerable on globalApi.
	// -----------------------------------------------------------------------
	it('should call registerEnumerableApiNames with names from __diminaRegisteredApis (native global source)', async () => {
		globalThis.__diminaRegisteredApis = ['myCustomPay', 'myCustomLogin']

		await import('../src/core/env.js')

		expect(mockRegisterEnumerableApiNames).toHaveBeenCalledWith(['myCustomPay', 'myCustomLogin'])
	})

	// -----------------------------------------------------------------------
	// Bug caught: env.js falls back to self.name for apiNamespaces but does
	// not do the same for registeredApis, so JSON-encoded config is ignored.
	// -----------------------------------------------------------------------
	it('should call registerEnumerableApiNames with names from self.name JSON when __diminaRegisteredApis is absent (JSON fallback source)', async () => {
		globalThis.name = JSON.stringify({ registeredApis: ['jsonApi1', 'jsonApi2'] })

		await import('../src/core/env.js')

		expect(mockRegisterEnumerableApiNames).toHaveBeenCalledWith(['jsonApi1', 'jsonApi2'])
	})

	// -----------------------------------------------------------------------
	// Bug caught: __diminaRegisteredApis is present but ignored in favour of
	// the JSON config, causing stale or wrong API lists to be registered.
	// -----------------------------------------------------------------------
	it('should prefer __diminaRegisteredApis over self.name registeredApis when both are present', async () => {
		globalThis.__diminaRegisteredApis = ['nativeApi']
		globalThis.name = JSON.stringify({ registeredApis: ['jsonApi'] })

		await import('../src/core/env.js')

		const calls = mockRegisterEnumerableApiNames.mock.calls
		// Must have been called exactly with the native list, not the JSON list
		expect(calls.some(call => JSON.stringify(call[0]) === JSON.stringify(['nativeApi']))).toBe(true)
		expect(calls.every(call => !call[0].includes('jsonApi'))).toBe(true)
	})

	// -----------------------------------------------------------------------
	// Bug caught: registerEnumerableApiNames is called with undefined or null when
	// neither source provides registeredApis, corrupting the internal Set.
	// -----------------------------------------------------------------------
	it('should call registerEnumerableApiNames with an empty array when neither source provides registeredApis', async () => {
		// Neither __diminaRegisteredApis nor self.name.registeredApis is set
		globalThis.__diminaRegisteredApis = undefined
		globalThis.name = JSON.stringify({ apiNamespaces: ['qd'] }) // no registeredApis key

		await import('../src/core/env.js')

		// registerEnumerableApiNames must be called (not skipped) and must receive []
		expect(mockRegisterEnumerableApiNames).toHaveBeenCalled()
		const firstCall = mockRegisterEnumerableApiNames.mock.calls[0]
		expect(firstCall[0]).toEqual([])
	})
})
