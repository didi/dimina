import { describe, expect, it } from 'vitest'
import runtime from '../src/core/runtime.js'

function renderList(source, render) {
	const target = {}
	runtime.installVueRuntimeHelpers(target)
	return target._renderList(source, render)
}

describe('WXML numeric list rendering', () => {
	// Verified against the locally installed wcc wfor loop.
	it.each([
		[0, []],
		[1, ['0:0']],
		[3, ['0:0', '1:1', '2:2']],
		[-2, []],
		[2.5, ['0:0', '1:1', '2:2']],
		[Number.NaN, []],
	])('renders the WXML numeric range %s', (source, expected) => {
		expect(renderList(source, (item, index) => item + ':' + index)).toEqual(expected)
	})

	it.each([Infinity, -Infinity])('bounds a non-terminating numeric range %s', (source) => {
		expect(renderList(source, (item, index) => item + ':' + index)).toEqual([])
	})

	it('preserves the compiler capture index when nested loops shadow index', () => {
		expect(renderList(2, (item, index, captured) => [item, index, captured]))
			.toEqual([[0, 0, 0], [1, 1, 1]])
	})

	it('preserves array, string, and object iteration and captured indexes', () => {
		expect(renderList(['a', 'b'], (item, index, captured) => [item, index, captured]))
			.toEqual([['a', 0, 0], ['b', 1, 1]])
		expect(renderList('ab', (item, index) => [item, index]))
			.toEqual([['a', 0], ['b', 1]])
		expect(renderList({ a: 1, b: 2 }, (item, key, position) => [item, key, position]))
			.toEqual([[1, 'a', 0], [2, 'b', 1]])
	})
})
