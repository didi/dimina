import { beforeEach, describe, expect, it, vi } from 'vitest'
import runtime from '../src/core/runtime'
import { Component } from '../src/instance/component/component'
import { Page } from '../src/instance/page/page'

describe('wx://component-export query results', () => {
	let caller, child
	beforeEach(() => {
		caller = { bridgeId: 'export', __id__: 'caller' }
		child = { bridgeId: 'export', __id__: 'child', __parentId__: 'caller', id: 'child', __targetInfo__: { class: 'child' }, hasBehavior: name => name === 'wx://component-export', export: vi.fn(() => ({ public: true })) }
		runtime.instances = { export: { caller, child } }
	})
	it.each([Page, Component])('exports every selected child with its querying instance (%s)', (Type) => {
		expect(Type.prototype.selectAllComponents.call(caller, '.child')).toEqual([{ public: true }])
		expect(child.export).toHaveBeenCalledWith(caller)
	})
	it.each([Page, Component])('falls back only for undefined export results (%s)', (Type) => {
		child.export.mockReturnValue(undefined)
		expect(Type.prototype.selectComponent.call(caller, '#child')).toBe(child)
		expect(child.export).toHaveBeenCalledWith(caller)
		child.export.mockReturnValue(null)
		expect(Type.prototype.selectComponent.call(caller, '#child')).toBeNull()
	})
	it('passes the querying child into its owner export and falls back to the owner', () => {
		caller.__ownerId__ = 'child'
		child.export.mockReturnValue(undefined)
		expect(Component.prototype.selectOwnerComponent.call(caller)).toBe(child)
		expect(child.export).toHaveBeenCalledWith(caller)
	})
})
