import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { matchesPropertyType, normalizePropertyDefinition, normalizePropertyValues, resolvePropertyValue } from '../src/core/properties'

describe('mini-program property semantics', () => {
	it('applies implicit defaults and clones mutable defaults', () => {
		const arraySchema = normalizePropertyDefinition(Array)
		const first = resolvePropertyValue(arraySchema, undefined, { absent: true })
		const second = resolvePropertyValue(arraySchema, undefined, { absent: true })

		expect(normalizePropertyDefinition(String).value).toBe('')
		expect(normalizePropertyDefinition(Number).value).toBe(0)
		expect(normalizePropertyDefinition(Boolean).value).toBe(false)
		expect(normalizePropertyDefinition(Object).value).toBeNull()
		expect(first).toEqual([])
		expect(first).not.toBe(second)
	})

	it('accepts only the property types supported by exparser', () => {
		expect(normalizePropertyDefinition(Function)).toEqual({
			type: null,
			optionalTypes: [],
			value: null,
		})
		expect(normalizePropertyDefinition({
			type: Function,
			optionalTypes: [String],
		})).toEqual({
			type: String,
			optionalTypes: [String],
			value: '',
		})
	})

	it('converts values with WeChat primary type rules', () => {
		expect(resolvePropertyValue(normalizePropertyDefinition(String), true)).toBe('true')
		expect(resolvePropertyValue(normalizePropertyDefinition(String), null)).toBe('')
		expect(resolvePropertyValue(normalizePropertyDefinition(Number), '12.5')).toBe(12.5)
		expect(resolvePropertyValue(normalizePropertyDefinition(Number), 'invalid')).toBe(0)
		expect(resolvePropertyValue(normalizePropertyDefinition(Boolean), '')).toBe(false)
		expect(resolvePropertyValue(normalizePropertyDefinition(Boolean), 'false')).toBe(true)
		expect(resolvePropertyValue(normalizePropertyDefinition(Array), {})).toEqual([])
		expect(resolvePropertyValue(normalizePropertyDefinition(Object), 'value')).toBeNull()
	})

	it('keeps values that strictly match optionalTypes', () => {
		const schema = normalizePropertyDefinition({
			type: String,
			optionalTypes: [Boolean, Object],
		})
		const objectValue = { ok: true }

		expect(resolvePropertyValue(schema, true)).toBe(true)
		expect(resolvePropertyValue(schema, objectValue)).toBe(objectValue)
		expect(resolvePropertyValue(schema, 42)).toBe('42')

		class ArraySubclass extends Array {}
		const arraySubclass = new ArraySubclass()
		expect(matchesPropertyType(Array, [])).toBe(true)
		expect(matchesPropertyType(Array, arraySubclass)).toBe(false)
		expect(resolvePropertyValue(normalizePropertyDefinition(Array), arraySubclass)).toBe(arraySubclass)
	})

	it('accepts native arrays passed from another JavaScript realm', () => {
		const foreignArray = runInNewContext('[{ title: "首页" }]')

		expect(Array.isArray(foreignArray)).toBe(true)
		expect(foreignArray.constructor).not.toBe(Array)
		expect(matchesPropertyType(Array, foreignArray)).toBe(true)
		expect(resolvePropertyValue(normalizePropertyDefinition(Array), foreignArray)).toBe(foreignArray)
	})

	it('distinguishes absent properties from explicitly passed undefined', () => {
		const schemas = {
			label: normalizePropertyDefinition({ type: String, value: 'default-label' }),
		}
		const warnings = vi.fn()

		expect(normalizePropertyValues(schemas, {}, { warn: warnings })).toEqual({ label: 'default-label' })
		expect(normalizePropertyValues(schemas, { label: undefined }, { warn: warnings })).toEqual({ label: '' })
		expect(warnings).toHaveBeenCalledTimes(1)
	})
})
