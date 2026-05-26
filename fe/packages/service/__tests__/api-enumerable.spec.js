/**
 * Tests for the enumerability contract on globalApi (src/api/index.js):
 *   - Named export `registerEnumerableApiNames(names: string[])` defines
 *     each name as a real own enumerable property on the underlying api
 *     object via Object.defineProperty.
 *   - Because the Proxy does not trap ownKeys / getOwnPropertyDescriptor,
 *     these properties are reflected through to globalApi, so frameworks
 *     that build their API surface from `Object.keys(wx)` (e.g. Taro)
 *     pick them up.
 *   - Calls still flow through invokeAPI, identical to the historical
 *     get-trap fallback behaviour for names not present in core/.
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
import globalApi, { registerEnumerableApiNames } from '../src/api/index.js'

// ---------------------------------------------------------------------------
// Helper: a name that definitely does not exist in any core/**/index.js
// ---------------------------------------------------------------------------
const NOVEL = '__novelCustomApiForTest__'
const NOVEL_2 = '__novelCustomApiForTest2__'

// ---------------------------------------------------------------------------
// Seed the names before the describe block. Since registration writes real
// own properties on the shared api object, state persists across tests.
// ---------------------------------------------------------------------------
beforeAll(() => {
	registerEnumerableApiNames([NOVEL, NOVEL_2])
})

afterAll(() => {
	vi.restoreAllMocks()
})

describe('globalApi enumerability contract', () => {
	// -----------------------------------------------------------------------
	// 1. Registered name appears in Object.keys / `in` / getOwnPropertyDescriptor
	//    Bug caught: registration silently failed to define an own property,
	//    so host code iterating the api object to build a bridge catalogue
	//    would miss it.
	// -----------------------------------------------------------------------
	it('registered name appears in Object.keys, `in`, and getOwnPropertyDescriptor', () => {
		expect(Object.keys(globalApi)).toContain(NOVEL)
		expect(NOVEL in globalApi).toBe(true)

		const desc = Object.getOwnPropertyDescriptor(globalApi, NOVEL)
		expect(desc).toBeDefined()
		expect(desc.enumerable).toBe(true)
		expect(desc.configurable).toBe(true)
		expect(typeof desc.value).toBe('function')
	})

	// -----------------------------------------------------------------------
	// 2. Calling a registered API forwards to invokeAPI with the correct name.
	//    Bug caught: defined property returns a stub but does not actually
	//    call invokeAPI, so cross-layer RPC is never sent.
	// -----------------------------------------------------------------------
	it('calling a registered API forwards to invokeAPI with the correct name and returns its result', () => {
		vi.mocked(invokeAPI).mockReturnValueOnce('bridge-return')

		const result = globalApi[NOVEL]({ key: 'val' })

		expect(invokeAPI).toHaveBeenCalledWith(NOVEL, { key: 'val' })
		expect(result).toBe('bridge-return')
	})

	// -----------------------------------------------------------------------
	// 3. Each registered name gets a handler bound to its own name — no
	//    closure-capture bug where all stubs share the last registered name.
	//    Bug caught: loop closes over a single mutating variable, all stubs
	//    invoke invokeAPI('__novelCustomApiForTest2__', ...) regardless of
	//    which property is accessed.
	// -----------------------------------------------------------------------
	it('distinct registered names each forward to invokeAPI with their own name (no closure-capture bug)', () => {
		vi.mocked(invokeAPI).mockClear()

		globalApi[NOVEL]('arg-a')
		globalApi[NOVEL_2]('arg-b')

		const calls = vi.mocked(invokeAPI).mock.calls
		expect(calls[0][0]).toBe(NOVEL)
		expect(calls[1][0]).toBe(NOVEL_2)
	})

	// -----------------------------------------------------------------------
	// 4. Static core API names stay enumerable — no-regression check.
	// -----------------------------------------------------------------------
	it('static core API "login" is still enumerable in Object.keys after registration', () => {
		expect(Object.keys(globalApi)).toContain('login')
	})

	// -----------------------------------------------------------------------
	// 5. A registered name that collides with a static core API does NOT
	//    overwrite the core implementation and does NOT produce a duplicate
	//    key in Object.keys.
	//    Bug caught: registration overrides an in-tree implementation with a
	//    bare invokeAPI forwarder, silently breaking the real behaviour.
	// -----------------------------------------------------------------------
	it('passing a static core API name ("login") to registerEnumerableApiNames does not duplicate or override it', () => {
		const descBefore = Object.getOwnPropertyDescriptor(globalApi, 'login')
		registerEnumerableApiNames(['login'])
		const descAfter = Object.getOwnPropertyDescriptor(globalApi, 'login')
		expect(descAfter.value).toBe(descBefore.value)

		const keys = Object.keys(globalApi)
		expect(keys.filter(k => k === 'login').length).toBe(1)
	})

	// -----------------------------------------------------------------------
	// 6. A name never registered and not in core does NOT appear in keys.
	// -----------------------------------------------------------------------
	it('a name never passed to registerEnumerableApiNames and not in core is absent from Object.keys', () => {
		const ghost = '__ghostApiNeverRegistered__'
		expect(Object.keys(globalApi)).not.toContain(ghost)
		expect(ghost in globalApi).toBe(false)
	})

	// -----------------------------------------------------------------------
	// 6b. registerEnumerableApiNames ignores Object.prototype member names.
	//     Bug caught: registering a name like `toString` would shadow
	//     Object.prototype.toString with a bare invokeAPI forwarder, breaking
	//     anything that relies on the inherited implementation.
	// -----------------------------------------------------------------------
	it('registerEnumerableApiNames ignores Object.prototype member names such as "toString"', () => {
		registerEnumerableApiNames(['toString'])
		expect(Object.keys(globalApi)).not.toContain('toString')
		// toString is still inherited from Object.prototype, not an own prop.
		expect(Object.getOwnPropertyDescriptor(globalApi, 'toString')).toBeUndefined()
	})
})
