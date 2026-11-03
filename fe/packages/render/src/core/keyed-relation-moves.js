import { LinkedOrder } from '@dimina/common'
import { Fragment } from 'vue'

// Vue's keyed v-for fragment flag.
const KEYED_FRAGMENT = 128

function walk(vnode, visit) {
	if (!vnode || typeof vnode !== 'object') return
	if (visit(vnode) === false) return
	if (vnode.component) walk(vnode.component.subTree, visit)
	else if (vnode.suspense) walk(vnode.suspense.activeBranch, visit)
	else if (Array.isArray(vnode.children)) {
		for (const child of vnode.children) walk(child, visit)
	}
}

function restorePreviousOrder(parent, records) {
	const order = new LinkedOrder(parent.childNodes)
	for (let i = records.length - 1; i >= 0; i--) {
		const { addedNodes, removedNodes, nextSibling, previousSibling } = records[i]
		for (const node of addedNodes) order.remove(node)
		const before = order.has(nextSibling) ? nextSibling : order.next(previousSibling)
		for (const node of removedNodes) order.insertBefore(node, before)
	}
	return order
}

// Prefer the stable subsequence with the smallest old position at each length,
// as Glass Easel does for uniquely keyed rows.
function stableRows(rows, previousIndex) {
	const tails = []
	const predecessor = new Map()
	for (const row of rows) {
		const index = previousIndex.get(row.el)
		let lo = 0
		let hi = tails.length
		while (lo < hi) {
			const mid = (lo + hi) >>> 1
			if (previousIndex.get(tails[mid].el) < index) lo = mid + 1
			else hi = mid
		}
		predecessor.set(row, tails[lo - 1])
		tails[lo] = row
	}
	const stable = new Set()
	for (let row = tails.at(-1); row; row = predecessor.get(row)) stable.add(row)
	return stable
}

function sameFragmentNodes(fragment, previous) {
	if (!previous.has(fragment.el) || !previous.has(fragment.anchor)) return false
	const current = new Set()
	for (let node = fragment.el.nextSibling; node && node !== fragment.anchor; node = node.nextSibling) {
		current.add(node)
	}
	for (let node = previous.next(fragment.el); node !== fragment.anchor; node = previous.next(node)) {
		if (!current.delete(node)) return false
	}
	return current.size === 0
}

export function planKeyedRelationMoves(roots, recordsByParent, nodes, moduleIds) {
	const plans = []
	const previousOrders = new Map()
	const visited = new Set()
	const renderOrder = new Map(nodes.map(({ moduleId }, index) => [moduleId, index]))
	const previouslyRendered = new Set(nodes.filter(node => node.previousOrder !== undefined).map(node => node.moduleId))
	const visit = (fragment) => {
		if (visited.has(fragment)) return false
		visited.add(fragment)
		const rows = fragment.children
		const parent = fragment.el?.parentNode
		if (fragment.type !== Fragment || fragment.patchFlag <= 0 || !(fragment.patchFlag & KEYED_FRAGMENT)
			|| !recordsByParent.has(parent) || !Array.isArray(rows) || rows.length < 2
			|| rows.some(row => row.key == null || row.el?.parentNode !== parent)
			|| new Set(rows.map(row => row.key)).size !== rows.length) return

		let previous = previousOrders.get(parent)
		if (!previous) {
			const order = restorePreviousOrder(parent, recordsByParent.get(parent))
			previous = { order, index: new Map([...order].map((node, index) => [node, index])) }
			previousOrders.set(parent, previous)
		}
		if (!sameFragmentNodes(fragment, previous.order)) return
		const oldRows = [...rows].sort((a, b) => previous.index.get(a.el) - previous.index.get(b.el))
		if (oldRows.every((row, index) => row === rows[index])) return

		const rowModules = new Map()
		for (const row of rows) {
			const ids = new Set()
			walk(row, (vnode) => {
				const id = moduleIds.get(vnode.component?.proxy)
				if (renderOrder.has(id)) ids.add(id)
			})
			rowModules.set(row, [...ids].sort((a, b) => renderOrder.get(a) - renderOrder.get(b)))
		}
		const ids = [...rowModules.values()].flat()
		if (!ids.length || ids.some(id => !previouslyRendered.has(id))) return
		const steps = []
		plans.push({ ids, steps })

		const stable = stableRows(rows, previous.index)
		const order = new LinkedOrder(oldRows)
		const anchors = new Map()
		let nextStable
		for (let i = rows.length - 1; i >= 0; i--) {
			if (stable.has(rows[i])) nextStable = rows[i]
			else anchors.set(rows[i], nextStable)
		}
		let afterList
		for (const node of nodes) {
			if (node.previousOrder === undefined || !node.root
				|| !(fragment.anchor.compareDocumentPosition(node.root) & Node.DOCUMENT_POSITION_FOLLOWING)) continue
			if (!afterList || node.previousOrder < afterList.previousOrder) afterList = node
		}
		for (const [row, ids] of rowModules) {
			if (stable.has(row)) continue
			order.insertBefore(row, anchors.get(row))
			if (!ids.length) continue
			let next = order.next(row)
			while (next && !rowModules.get(next).length) next = order.next(next)
			steps.push({ ids, beforeId: next ? rowModules.get(next)[0] : afterList?.moduleId })
		}
	}
	for (const root of roots) walk(root, visit)

	// Concurrent nested permutations can affect the same component subtree.
	// Keep the DOM notifications for those overlaps instead of replaying it twice.
	const owners = new Map()
	const conflicts = new Set()
	for (const plan of plans) {
		for (const id of plan.ids) {
			const owner = owners.get(id)
			if (owner) {
				conflicts.add(owner)
				conflicts.add(plan)
			}
			else owners.set(id, plan)
		}
	}
	const replayable = plans.filter(plan => !conflicts.has(plan))
	return { steps: replayable.flatMap(plan => plan.steps), covered: new Set(replayable.flatMap(plan => plan.ids)) }
}
