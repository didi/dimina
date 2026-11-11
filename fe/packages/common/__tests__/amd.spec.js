import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hasModule, modDefine, modRequire } from '../src/core/amd'

// Contract checked against WebNode in the developer tool's bundled 2.25.3 WAService.js.
describe('mini-program module loading', () => {
	let prefix
	beforeEach(() => { prefix = 'amd-' + crypto.randomUUID() + '/' })
	afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

	it('exposes partially initialized exports to circular dependencies', () => {
		modDefine(prefix + 'a', (require, module, exports) => {
			exports.stage = 'initializing'
			exports.b = require(prefix + 'b')
			exports.stage = 'ready'
		})
		modDefine(prefix + 'b', (require, module, exports) => {
			exports.a = require(prefix + 'a')
			exports.observedStage = exports.a.stage
		})
		const a = modRequire(prefix + 'a')
		expect(a.b.observedStage).toBe('initializing')
		expect(a.b.a).toBe(a)
	})

	it('invalidates a cached module only when its factory source changes', () => {
		const first = (require, module) => { module.exports = { version: 1 } }
		modDefine(prefix + 'version', first)
		const original = modRequire(prefix + 'version')
		modDefine(prefix + 'version', first)
		expect(modRequire(prefix + 'version')).toBe(original)
		modDefine(prefix + 'version', (require, module) => { module.exports = { version: 2 } })
		expect(modRequire(prefix + 'version')).toEqual({ version: 2 })
	})

	it('propagates evaluation errors and retries with fresh exports', () => {
		vi.spyOn(console, 'error').mockImplementation(() => {})
		const report = vi.fn()
		vi.stubGlobal('__diminaReportError', report)
		const error = new Error('dependency failed')
		let attempts = 0
		modDefine(prefix + 'dependency', (require, module, exports) => {
			if (++attempts === 1) { exports.stale = true; throw error }
			exports.ready = true
		})
		modDefine(prefix + 'parent', (require, module) => {
			module.exports = require(prefix + 'dependency')
		})
		expect(() => modRequire(prefix + 'parent')).toThrow(error)
		expect(report).not.toHaveBeenCalled()
		expect(modRequire(prefix + 'parent')).toEqual({ ready: true })
	})

	it('defers callback-style requires and returns undefined', async () => {
		modDefine(prefix + 'async', (require, module) => { module.exports = { ready: true } })
		const callback = vi.fn()
		expect(modRequire(prefix + 'async', callback)).toBeUndefined()
		expect(callback).not.toHaveBeenCalled()
		await new Promise(resolve => setTimeout(resolve, 0))
		expect(callback).toHaveBeenCalledExactlyOnceWith({ ready: true })
	})

	it('rejects async require with the standard failure payload', async () => {
		await expect(modRequire.async(prefix + 'missing')).rejects.toEqual({
			mod: prefix + 'missing',
			errMsg: expect.stringContaining(prefix + 'missing'),
		})
	})

	it('calls strict module factories without exposing the internal module record', () => {
		modDefine(prefix + 'strict', function (require, module) {
			'use strict'
			module.exports = this
		})
		expect(modRequire(prefix + 'strict')).toBeUndefined()
	})

	it('allows module IDs that match Object prototype members', () => {
		for (const id of ['constructor', 'toString', '__proto__']) {
			expect(hasModule(id)).toBe(false)
			modDefine(id, (require, module) => { module.exports = id })
			expect(hasModule(id)).toBe(true)
			expect(modRequire(id)).toBe(id)
		}
	})
})
