import { describe, expect, it } from 'vitest'
import { parseWxmlSelector, WxmlTree } from '../src/core/wxml-tree'

function fixture() {
	return new WxmlTree([
		{ nodeId: 's:page', scopeId: 'page', shadow: true },
		{ nodeId: 'wrap', parentId: 's:page', scopeId: 'page', id: 'wrap', class: 'wrap', marks: { global: 'page' } },
		{ nodeId: 'host', parentId: 'wrap', scopeId: 'page', id: 'host', class: 'host active', shadowRootId: 's:host', marks: { entry: 'host' } },
		{ nodeId: 's:host', scopeId: 'host', shadow: true, hostId: 'host' },
		{ nodeId: 'inside', parentId: 's:host', scopeId: 'host', id: 'inside', class: 'inside', marks: { entry: 'inside', local: 'outer' } },
		{ nodeId: 'leaf', parentId: 'inside', scopeId: 'host', id: 'leaf', class: 'leaf', marks: { entry: 'leaf' } },
		{ nodeId: 'slot', parentId: 'inside', scopeId: 'host', id: '', virtual: true },
		{ nodeId: 'slotted', parentId: 'host', composedParentId: 'slot', scopeId: 'page', id: 'slotted', class: 'slotted', marks: { entry: 'slotted' } },
	])
}

describe('WXML selector and event tree contracts', () => {
	// Expected values were run against the app's bundled 2.25.3 Element parser/matcher.
	it.each([
		['.host.active', ['host']],
		['#wrap > .host', ['host']],
		['.leaf', []],
		['.host >>> .inside > .leaf', ['leaf']],
		['.host .slotted', ['slotted']],
		['#leaf, .host >>> .leaf', ['leaf']],
		['view', []],
		['[id=host]', []],
		['.host, .slotted, .host', ['host', 'slotted']],
	])('matches %s with the mini-program grammar and shadow boundary', (selector, expected) => {
		expect(fixture().query('page', selector).map(node => node.id)).toEqual(expected)
	})
	it('does not let one union branch implicitly pierce another branch shadow boundary', () => {
		expect(fixture().query('page', '.leaf, .host >>> .missing')).toEqual([])
		expect(parseWxmlSelector('')).toBeNull()
	})
	it('restores the light-tree target after an event leaves a slot insertion tree', () => {
		const tree = fixture()
		const path = tree.eventPath(tree.nodes.get('slotted'), true)
		const relevant = path.filter(({ node }) => ['slotted', 'inside', 'host'].includes(node.id))
		expect(relevant.map(({ node, target, mark }) => [node.id, target.id, mark])).toEqual([
			['slotted', 'slotted', { entry: 'slotted', global: 'page' }],
			['inside', '', { entry: 'inside', local: 'outer' }],
			['host', 'slotted', { entry: 'slotted', global: 'page' }],
		])
	})
})
