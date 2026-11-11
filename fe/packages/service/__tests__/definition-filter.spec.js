import { describe, expect, it } from 'vitest'
import '../src/core/env'
import { ComponentModule } from '../src/instance/component/component-module'
import { PageModule } from '../src/instance/page/page-module'

const extra = { component: true, path: 'components/filter/index', usingComponents: {} }

describe('Behavior definitionFilter', () => {
	it('runs referenced filters when a behavior is declared and supplies their wrappers to its own filter', () => {
		const calls = []
		const base = Behavior({ definitionFilter(fields) {
			calls.push(['base', fields.tag])
			fields.data = { ...fields.data, base: true }
		} })
		const derived = Behavior({
			tag: 'behavior', behaviors: [base],
			definitionFilter(fields, filters) {
				calls.push(['derived', fields.tag, filters.length])
				filters[0](fields)
				fields.methods = { added() { return 'filtered' } }
			},
		})
		expect(calls).toEqual([['base', 'behavior']])

		const module = new ComponentModule({ tag: 'component', behaviors: [derived] }, extra)
		expect(calls).toEqual([['base', 'behavior'], ['derived', 'component', 1], ['base', 'component']])
		expect(module.noReferenceData.base).toBe(true)
		expect(module.moduleInfo.methods.added()).toBe('filtered')
	})

	it('runs direct filters in declaration order before merging component data and Page methods', () => {
		const calls = []
		const first = Behavior({ definitionFilter(fields) {
			calls.push('first')
			fields.data = { ...fields.data, injected: 'first' }
		} })
		const second = Behavior({ definitionFilter(fields) {
			calls.push('second')
			fields.methods = { injectedMethod() { return this.data.injected } }
		} })
		const module = new PageModule({ behaviors: [first, second] }, { ...extra, component: false })
		expect(calls).toEqual(['first', 'second'])
		expect(module.noReferenceData.injected).toBe('first')
		expect(module.moduleInfo.injectedMethod).toBeTypeOf('function')
	})
})
