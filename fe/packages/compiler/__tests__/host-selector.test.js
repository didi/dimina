import { describe, it, expect } from 'vitest'
import { processHostSelector } from '../src/core/style-compiler.js'

describe('Host Selector Processing', () => {
	const moduleId = 'test-component-123'
	const hostSelector = `[data-dd-style-host~="${moduleId}"]`

	it('should handle :host selector alone', () => {
		const selector = ':host'
		const result = processHostSelector(selector, moduleId)
		expect(result).toBe(hostSelector)
	})

	it('should handle :host with class selector', () => {
		const selector = ':host(.active)'
		const result = processHostSelector(selector, moduleId)
		expect(result).toBe(`${hostSelector}.active`)
	})

	it('should handle :host with descendant selector', () => {
		const selector = ':host .child'
		const result = processHostSelector(selector, moduleId)
		expect(result).toBe(`${hostSelector} .child`)
	})

	it('should handle :host with compound selector', () => {
		const selector = ':host.active'
		const result = processHostSelector(selector, moduleId)
		expect(result).toBe(`${hostSelector}.active`)
	})

	it('should handle :host with pseudo-class', () => {
		const selector = ':host:hover'
		const result = processHostSelector(selector, moduleId)
		expect(result).toBe(`${hostSelector}:hover`)
	})

	it('should handle multiple :host selectors', () => {
		const selector = ':host .child, :host(.active) .item'
		const result = processHostSelector(selector, moduleId)
		expect(result).toBe(`${hostSelector} .child, ${hostSelector}.active .item`)
	})

	it('should handle complex :host selectors', () => {
		const selector = ':host(.theme-dark) .content > .item:first-child'
		const result = processHostSelector(selector, moduleId)
		expect(result).toBe(`${hostSelector}.theme-dark .content > .item:first-child`)
	})

	it('should handle standalone :host selectors in a selector list', () => {
		const selector = ':host, :host.active'
		const result = processHostSelector(selector, moduleId)
		expect(result).toBe(`${hostSelector}, ${hostSelector}.active`)
	})

	it('should not affect non-host selectors', () => {
		const selector = '.normal-class .item'
		const result = processHostSelector(selector, moduleId)
		expect(result).toBe('.normal-class .item')
	})
})
