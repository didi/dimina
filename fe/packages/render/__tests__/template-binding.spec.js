import { describe, expect, it, vi } from 'vitest'
import runtime from '../src/core/runtime'

describe('template binding assignment index', () => {
	it('only resolves the affected row and skips evaluating unrelated bindings', () => {
		const ownerId = 'binding-index-test'
		const rows = Array.from({ length: 1000 }, (_, id) => ({ id, value: id, note: '' }))
		const resolvePaths = vi.fn(() => [['row', 'value']])
		const read = vi.fn(row => row.value)
		const notify = vi.fn()
		const unregister = rows.map((row, index) => runtime.registerPropertyAssignments(ownerId, `row-${index}`, {
			value: { type: Number },
		}, {
			value: {
				dependencies: ['row'],
				dependencyPaths: [['row', 'value']],
				renderOnly: true,
				renderRoots: ['rows'],
				scopes: [{ item: 'row', index, source: ['rows'], key: 'id', keyValue: row.id }],
				resolvePaths,
				read,
			},
		}, notify))
		try {
			runtime.notifyPropertyAssignments(ownerId, [['unrelated']], undefined, { rows })
			expect(resolvePaths).not.toHaveBeenCalled()
			runtime.notifyPropertyAssignments(ownerId, [['rows', 500, 'note']], undefined, { rows })
			expect(resolvePaths).not.toHaveBeenCalled()
			expect(read).not.toHaveBeenCalled()
			expect(notify).not.toHaveBeenCalled()

			runtime.notifyPropertyAssignments(ownerId, [['rows', 500, 'value']], undefined, { rows })
			expect(resolvePaths).toHaveBeenCalledTimes(1)
			expect(read).toHaveBeenCalledExactlyOnceWith(rows[500], 500)
			expect(notify).toHaveBeenCalledExactlyOnceWith({
				names: ['value'], values: new Map([['value', 500]]), replay: true,
			})
		}
		finally {
			unregister.forEach(dispose => dispose())
		}
		expect(runtime.propertyAssignments.has(ownerId)).toBe(false)
	})
})
