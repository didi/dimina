import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:worker_threads', async (importOriginal) => {
	const original = await importOriginal()
	return { ...original, isMainThread: false }
})

const {
	checkTemplateCompatibility,
	takeCompatibilityWarnings,
	warnUnsupportedWxApi,
} = await import('../src/common/compatibility.js')

describe('worker compatibility diagnostics', () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('collects deduplicated warnings in discovery order without writing to the terminal', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

		warnUnsupportedWxApi('getUserProfile', '/pages/index/index.js', 2)
		warnUnsupportedWxApi('getUserProfile', '/pages/index/index.js', 2)
		checkTemplateCompatibility('<unknown-element />', '/pages/index/index.wxml')

		expect(warn).not.toHaveBeenCalled()
		expect(takeCompatibilityWarnings()).toEqual([
			'[compat] Unsupported wx API: wx.getUserProfile (/pages/index/index.js:2)',
			'[compat] Unsupported or undeclared component: <unknown-element> (/pages/index/index.wxml:1)',
		])
		expect(takeCompatibilityWarnings()).toEqual([])
	})
})
