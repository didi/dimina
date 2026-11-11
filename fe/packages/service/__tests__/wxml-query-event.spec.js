import { WxmlTree } from '@dimina/common'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import runtime from '../src/core/runtime'
import { Page } from '../src/instance/page/page'
import { PageModule } from '../src/instance/page/page-module'
import { Component } from '../src/instance/component/component'
import { ComponentModule } from '../src/instance/component/component-module'

describe('committed WXML tree queries and custom events', () => {
	let page, outer, leaf, second, records
	const bridgeId = 'wxml-tree-contract'
	beforeEach(() => {
		runtime.instances[bridgeId] = {}
		page = new Page(new PageModule({}, { path: 'page' }), { bridgeId, moduleId: 'page', path: 'page' })
		const create = (id, ownerId, parentId, className) => new Component(new ComponentModule({}, {
			component: true, path: id, usingComponents: {},
		}), {
			bridgeId, moduleId: id, path: id, pageId: ownerId, parentId, ownerId,
			targetInfo: { id, class: className, dataset: {} }, properties: {},
		})
		outer = create('outer', 'page', 'page', 'card active')
		leaf = create('leaf', 'outer', 'outer', 'leaf')
		second = create('second', 'page', 'page', 'card')
		Object.assign(runtime.instances[bridgeId], { page, second, leaf, outer })
		records = [
			{ nodeId: 's:page', scopeId: 'page', shadow: true },
			{ nodeId: 'wrap', parentId: 's:page', scopeId: 'page', id: 'wrap', class: 'wrapper', marks: { page: 1 } },
			{ nodeId: 'c:outer', parentId: 'wrap', scopeId: 'page', componentId: 'outer', id: 'outer', class: 'card active', shadowRootId: 's:outer', eventAttr: { change: { bind: 'pageChanged' } }, marks: { item: 'outer' } },
			{ nodeId: 's:outer', scopeId: 'outer', shadow: true, hostId: 'c:outer' },
			{ nodeId: 'inside', parentId: 's:outer', scopeId: 'outer', id: 'inside', class: 'inside', eventAttr: { change: { bind: 'insideChanged' } }, marks: { local: 2, item: 'inside' } },
			{ nodeId: 'c:leaf', parentId: 'inside', scopeId: 'outer', componentId: 'leaf', id: 'leaf', class: 'leaf', eventAttr: { change: { bind: 'leafChanged' } }, marks: { item: 'leaf' } },
			{ nodeId: 'c:second', parentId: 'wrap', scopeId: 'page', componentId: 'second', id: 'second', class: 'card' },
		]
		runtime.wxmlTrees ||= new Map()
		runtime.wxmlTrees.set(bridgeId, new WxmlTree(records))
	})
	afterEach(() => { delete runtime.instances[bridgeId]; runtime.wxmlTrees.delete(bridgeId) })

	it('matches id/class compounds, ordinary wrappers, child and descendant relations', () => {
		expect(page.selectComponent('#wrap > .card.active')).toBe(outer)
		expect(page.selectAllComponents('.wrapper .card')).toEqual([outer, second])
	})
	it('keeps internal nodes behind shadow roots unless >>> is explicit', () => {
		expect(page.selectComponent('.leaf')).toBeNull()
		expect(page.selectComponent('.card >>> .inside > .leaf')).toBe(leaf)
		expect(outer.selectComponent('.inside > .leaf')).toBe(leaf)
	})
	it('unions deduplicate and retain committed tree order rather than creation order', () => {
		expect(page.selectAllComponents('#second, .card, #outer')).toEqual([outer, second])
	})
	it('retains null entries for builtins and does not skip a builtin selected before a custom component', () => {
		expect(page.selectComponent('#wrap, #outer')).toBeNull()
		expect(page.selectAllComponents('#wrap, #outer')).toEqual([null, outer])
	})
	it('retargets composed events at the host and collects nearest marks per shadow segment', () => {
		const calls = []
		outer.leafChanged = vi.fn(event => calls.push(['leaf', event.target.id, { ...event.mark }]))
		outer.insideChanged = vi.fn(event => calls.push(['inside', event.target.id, { ...event.mark }]))
		page.pageChanged = vi.fn(event => calls.push(['page', event.target.id, { ...event.mark }]))
		leaf.triggerEvent('change', {}, { bubbles: true, composed: true })
		expect(calls).toEqual([
			['leaf', 'leaf', { item: 'leaf', local: 2 }],
			['inside', 'leaf', { item: 'leaf', local: 2 }],
			['page', 'outer', { item: 'outer', page: 1 }],
		])
	})
})
