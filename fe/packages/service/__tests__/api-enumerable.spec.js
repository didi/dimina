/**
 * Tests for the enumerability contract on globalApi (src/api/index.js):
 *   - Named export `setEnumerableApiNames(names: string[])` records "virtual"
 *     API names into an internal Set.
 *   - Proxy `has` / `ownKeys` / `getOwnPropertyDescriptor` traps make those
 *     recorded names enumerable on globalApi, so frameworks that build their
 *     API surface from `Object.keys(wx)` (e.g. Taro) pick them up.
 *
 * NOTE: `Object.preventExtensions` is irreversible and the module-level Set
 * persists across tests within a vitest worker. The non-extensible guard test
 * MUST be last, and earlier tests use `.includes()` rather than exact-array
 * equality to accommodate the cumulative Set state.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Mock heavy transitive dependencies that every core/**/index.js pulls in.
// @/api/common is the universal dep (invokeAPI); expose it as a vi.fn() so
// forwarding assertions can be made without touching real message channels.
// ---------------------------------------------------------------------------
vi.mock('@/api/common', () => ({
	invokeAPI: vi.fn(() => 'mocked-result'),
}))

vi.mock('@dimina/common', () => ({
	callback: { store: vi.fn(fn => fn) },
	isFunction: vi.fn(v => typeof v === 'function'),
	isWebWorker: false,
	parsePath: vi.fn(p => p),
	suffixPixel: vi.fn(v => v),
	uuid: vi.fn(() => 'test-uuid'),
	modDefine: vi.fn(),
	modRequire: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Import the REAL api/index.js (not a mock) so we exercise the actual Proxy.
// ---------------------------------------------------------------------------
import { invokeAPI } from '@/api/common'
import globalApi, { setEnumerableApiNames } from '../src/api/index.js'

// ---------------------------------------------------------------------------
// Helper: a name that definitely does not exist in any core/**/index.js
// ---------------------------------------------------------------------------
const NOVEL = '__novelCustomApiForTest__'
const NOVEL_2 = '__novelCustomApiForTest2__'

// ---------------------------------------------------------------------------
// Seed the virtual names before the describe block so all tests share state.
// (The implementation stores names in a module-level Set.)
// ---------------------------------------------------------------------------
beforeAll(() => {
	setEnumerableApiNames([NOVEL, NOVEL_2])
})

afterAll(() => {
	vi.restoreAllMocks()
})

describe('globalApi Proxy enumerability contract', () => {
	// -----------------------------------------------------------------------
	// 1. Virtual name appears in Object.keys / `in` / getOwnPropertyDescriptor
	//    Bug caught: ownKeys trap missing or has trap missing → silent failure
	//    when host code iterates the api object to build a bridge catalogue.
	// -----------------------------------------------------------------------
	it('virtual name not in core appears in Object.keys, `in`, and getOwnPropertyDescriptor', () => {
		expect(Object.keys(globalApi)).toContain(NOVEL)
		expect(NOVEL in globalApi).toBe(true)

		const desc = Object.getOwnPropertyDescriptor(globalApi, NOVEL)
		expect(desc).toBeDefined()
		expect(desc.enumerable).toBe(true)
		expect(desc.configurable).toBe(true)
		expect(typeof desc.value).toBe('function')
	})

	// -----------------------------------------------------------------------
	// 2. Calling a virtual API forwards to invokeAPI with the correct name.
	//    Bug caught: get trap returns a stub but does not actually call
	//    invokeAPI, so cross-layer RPC is never sent.
	// -----------------------------------------------------------------------
	it('calling a virtual API forwards to invokeAPI with the correct name and returns its result', () => {
		vi.mocked(invokeAPI).mockReturnValueOnce('bridge-return')

		const result = globalApi[NOVEL]({ key: 'val' })

		expect(invokeAPI).toHaveBeenCalledWith(NOVEL, { key: 'val' })
		expect(result).toBe('bridge-return')
	})

	// -----------------------------------------------------------------------
	// 3. Each virtual name gets a handler bound to its own name — no closure
	//    capture bug where all stubs share the last registered name.
	//    Bug caught: loop over Set closes over a single variable, all stubs
	//    invoke invokeAPI('__novelCustomApiForTest2__', ...) regardless of
	//    which property is accessed.
	// -----------------------------------------------------------------------
	it('distinct virtual names each forward to invokeAPI with their own name (no closure-capture bug)', () => {
		vi.mocked(invokeAPI).mockClear()

		globalApi[NOVEL]('arg-a')
		globalApi[NOVEL_2]('arg-b')

		const calls = vi.mocked(invokeAPI).mock.calls
		expect(calls[0][0]).toBe(NOVEL)
		expect(calls[1][0]).toBe(NOVEL_2)
	})

	// -----------------------------------------------------------------------
	// 4. Static core API names stay enumerable — no-regression check.
	//    Bug caught: ownKeys trap returns ONLY the virtual Set, dropping
	//    all real core APIs from enumeration.
	// -----------------------------------------------------------------------
	it('static core API "login" is still enumerable in Object.keys after virtual names are added', () => {
		expect(Object.keys(globalApi)).toContain('login')
	})

	// -----------------------------------------------------------------------
	// 5. A virtual name that collides with a static core API does NOT produce
	//    a duplicate key in Object.keys.
	//    Bug caught: ownKeys naively concatenates core keys + Set keys without
	//    deduplication.
	// -----------------------------------------------------------------------
	it('passing a static core API name ("login") to setEnumerableApiNames does not create a duplicate in Object.keys', () => {
		setEnumerableApiNames(['login'])
		const keys = Object.keys(globalApi)
		const loginCount = keys.filter(k => k === 'login').length
		expect(loginCount).toBe(1)
	})

	// -----------------------------------------------------------------------
	// 6. A name never registered and not in core does NOT appear in keys.
	//    Bug caught: over-broad ownKeys trap returns all possible names or
	//    the `in` trap always returns true.
	// -----------------------------------------------------------------------
	it('a name never passed to setEnumerableApiNames and not in core is absent from Object.keys', () => {
		const ghost = '__ghostApiNeverRegistered__'
		expect(Object.keys(globalApi)).not.toContain(ghost)
		expect(ghost in globalApi).toBe(false)
	})

	// -----------------------------------------------------------------------
	// 6b. setEnumerableApiNames ignores Object.prototype member names.
	//    Bug caught: registering a name like `toString` would be reported as
	//    an enumerable own API, yet `wx.toString` resolves to the inherited
	//    Object.prototype.toString — an inconsistency Taro's processApis
	//    would then wrap incorrectly.
	// -----------------------------------------------------------------------
	it('setEnumerableApiNames ignores Object.prototype member names such as "toString"', () => {
		setEnumerableApiNames(['toString'])
		expect(Object.keys(globalApi)).not.toContain('toString')
		expect(Object.getOwnPropertyDescriptor(globalApi, 'toString')).toBeUndefined()
	})

	// -----------------------------------------------------------------------
	// 7. Non-extensible guard: after Object.preventExtensions the virtual
	//    names are no longer reported and `in` returns false.
	//    Bug caught: ownKeys trap ignores extensibility, leaking virtual names
	//    after the object is sealed, breaking `for…in` / spread in frozen
	//    contexts.
	//
	//    MUST be last — preventExtensions is irreversible.
	// -----------------------------------------------------------------------
	it('after Object.preventExtensions, virtual names are absent from Object.keys and `in` returns false [LAST TEST]', () => {
		Object.preventExtensions(globalApi)

		expect(Object.keys(globalApi)).not.toContain(NOVEL)
		expect(NOVEL in globalApi).toBe(false)
	})
})
