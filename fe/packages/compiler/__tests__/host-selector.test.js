import { describe, it, expect } from 'vitest'
import { processHostSelector } from '../src/core/style-compiler.js'

describe('Host Selector Processing', () => {
	const moduleId = 'test-component-123'

	it('should handle :host selector alone', () => {
		const selector = ':host'
		const result = processHostSelector(selector, moduleId)
		expect(result).toBe(`[data-v-${moduleId}]`)
	})

	it('should handle :host with class selector', () => {
		const selector = ':host(.active)'
		const result = processHostSelector(selector, moduleId)
		expect(result).toBe(`[data-v-${moduleId}].active`)
	})

	it('should handle :host with descendant selector', () => {
		const selector = ':host .child'
		const result = processHostSelector(selector, moduleId)
		expect(result).toBe(`[data-v-${moduleId}] .child`)
	})

	it('should handle :host with compound selector', () => {
		const selector = ':host.active'
		const result = processHostSelector(selector, moduleId)
		expect(result).toBe(`[data-v-${moduleId}].active`)
	})

	it('should handle :host with pseudo-class', () => {
		const selector = ':host:hover'
		const result = processHostSelector(selector, moduleId)
		expect(result).toBe(`[data-v-${moduleId}]:hover`)
	})

	it('should handle multiple :host selectors', () => {
		const selector = ':host .child, :host(.active) .item'
		const result = processHostSelector(selector, moduleId)
		expect(result).toBe(`[data-v-${moduleId}] .child, [data-v-${moduleId}].active .item`)
	})

	it('should handle complex :host selectors', () => {
		const selector = ':host(.theme-dark) .content > .item:first-child'
		const result = processHostSelector(selector, moduleId)
		expect(result).toBe(`[data-v-${moduleId}].theme-dark .content > .item:first-child`)
	})

	it('should not affect non-host selectors', () => {
		const selector = '.normal-class .item'
		const result = processHostSelector(selector, moduleId)
		expect(result).toBe('.normal-class .item')
	})
}) 