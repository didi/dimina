import { describe, expect, it } from 'vitest'
import { Module } from '../src/core/module'

describe('render module property transport', () => {
	it('keeps mini-program schemas while disabling Vue prop casting', () => {
		const module = new Module({})
		module.setInitialData({
			label: { type: ['s'], default: 'label' },
			mixed: { type: ['s', 'b'], default: '' },
			active: { type: ['b'], default: false },
		})

		expect(module.props).toEqual({
			label: { type: null },
			mixed: { type: null },
			active: { type: null },
		})
		expect(module.propertySchemas.label).toMatchObject({ type: String, value: 'label' })
		expect(module.propertySchemas.mixed).toMatchObject({
			type: String,
			optionalTypes: [Boolean],
		})
		expect(module.propertySchemas.active).toMatchObject({ type: Boolean, value: false })
	})

	it('keeps builtin behavior metadata out of Vue props', () => {
		const module = new Module({})
		module.setInitialData({
			__diminaMeta: { builtinBehaviors: ['wx://form-field'] },
			name: { type: ['s'] },
			value: { type: [null] },
		})

		expect(module.builtinBehaviors.has('wx://form-field')).toBe(true)
		expect(module.props).toEqual({ name: { type: null }, value: { type: null } })
		expect(module.propertySchemas).not.toHaveProperty('__diminaMeta')
	})
})
