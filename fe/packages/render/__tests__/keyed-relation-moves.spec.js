import { describe, expect, it } from 'vitest'
import { Fragment } from 'vue'
import { planKeyedRelationMoves } from '../src/core/keyed-relation-moves'

describe('keyed relation move plans', () => {
	function plan(before, after, renderMoves, idsByRow) {
		const parent = document.createElement('div')
		const start = document.createTextNode('')
		const end = document.createTextNode('')
		const moduleIds = new WeakMap()
		const rows = new Map()
		const nodes = []
		parent.append(start)
		for (const key of before) {
			const el = document.createElement('section')
			const children = (idsByRow[key] || []).map((moduleId) => {
				const root = document.createElement('div')
				const proxy = {}
				moduleIds.set(proxy, moduleId)
				nodes.push({ root, moduleId, previousOrder: nodes.length })
				el.append(root)
				return { component: { proxy, subTree: { el: root } } }
			})
			rows.set(key, { key, el, children })
			parent.append(el)
		}
		parent.append(end)
		const observer = new MutationObserver(() => {})
		observer.observe(parent, { childList: true })
		for (const [key, next] of renderMoves) parent.insertBefore(rows.get(key).el, next ? rows.get(next).el : end)
		const records = observer.takeRecords()
		observer.disconnect()
		expect([...parent.children]).toEqual(after.map(key => rows.get(key).el))
		nodes.sort((a, b) => a.root.compareDocumentPosition(b.root) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)
		return planKeyedRelationMoves(
			[{ type: Fragment, patchFlag: 128, el: start, anchor: end, children: after.map(key => rows.get(key)) }],
			new Map([[parent, records]]),
			nodes,
			moduleIds,
		)
	}

	it('moves all component roots in a row together in WeChat order', () => {
		const result = plan(['a', 'b', 'c'], ['c', 'b', 'a'], [['b', 'a'], ['c', 'b']], {
			a: ['a1', 'a2'], b: ['b1', 'b2'], c: ['c1', 'c2'],
		})
		expect(result.steps).toEqual([
			{ ids: ['c1', 'c2'], beforeId: 'a1' },
			{ ids: ['b1', 'b2'], beforeId: 'a1' },
		])
		expect(result.covered).toEqual(new Set(['a1', 'a2', 'b1', 'b2', 'c1', 'c2']))
	})

	it('uses the keyed rows without components when choosing which rows stay put', () => {
		const result = plan(['a', 'b', 'c'], ['b', 'a', 'c'], [['a', 'c']], {
			a: ['a1'], c: ['c1'],
		})
		expect(result.steps).toEqual([])
		expect(result.covered).toEqual(new Set(['a1', 'c1']))
	})
	it('replays a move towards the end after the earlier backwards move', () => {
		const result = plan(['a', 'b', 'c', 'd', 'e'], ['b', 'e', 'c', 'a', 'd'], [['a', 'd'], ['e', 'c']], {
			a: ['a1'], b: ['b1'], c: ['c1'], d: ['d1'], e: ['e1'],
		})
		expect(result.steps).toEqual([
			{ ids: ['e1'], beforeId: 'c1' },
			{ ids: ['a1'], beforeId: 'd1' },
		])
	})

})
