import { getDataAttributes, uuid, WxmlTree } from '@dimina/common'
import { normalizeClass } from 'vue'

function eventBindings(props = {}) {
	const events = {}
	for (const [name, value] of Object.entries(props)) {
		const match = name.match(/^(capture-)?(bind|catch)(?::)?(.+)$/)
		if (!match || value == null || value === '') continue
		const [, capture, phase, type] = match
		const binding = capture ? phase === 'catch' ? 'captureCatch' : 'captureBind' : phase
		;(events[type] ||= {})[binding] = value
	}
	return events
}

function declaringModule(context, moduleIds) {
	if (!context || context.type?.__tagName) return
	const direct = moduleIds.get(context.proxy)
	if (direct) return direct
	const path = context.provides?.path
	return path && context.provides[path]?.id
}

/**
 * Read Vue's committed VNodes, not its flattened DOM. A custom component and its
 * internal root may share one element; fragments have no element at all. Keep
 * those WXML hosts and shadow roots as separate logical nodes.
 */
export function collectRenderedWxmlTree(page, pageId, moduleIds, nativeIds, collectRoots) {
	const records = [{ nodeId: `s:${pageId}`, scopeId: pageId, shadow: true }]
	const elements = new WeakMap()
	const rendered = new Map()
	const visited = new Set()
	const remember = (record, vnode) => {
		record.roots = collectRoots(vnode)
		const firstRoot = record.roots.find(element => element.nodeType === 1)
		record.offsetLeft = firstRoot?.offsetLeft || 0
		record.offsetTop = firstRoot?.offsetTop || 0
		for (const element of record.roots) {
			if (element.nodeType !== 1) continue
			const nodes = elements.get(element) || []
			nodes.push(record)
			elements.set(element, nodes)
		}
		rendered.set(record.nodeId, record)
	}
	const walk = (vnode, ancestors) => {
		if (!vnode || typeof vnode !== 'object' || visited.has(vnode)) return
		visited.add(vnode)
		const component = vnode.component
		const componentId = component && moduleIds.get(component.proxy)
		const ownerId = declaringModule(vnode.ctx, moduleIds)
		const slot = vnode.props?.diminaSlotBoundary === true
		const declared = ownerId && (slot || componentId || vnode.type?.__tagName || typeof vnode.type === 'string')
		let nextAncestors = ancestors
		if (declared && componentId !== pageId) {
			const props = vnode.props || {}
			let nodeId
			if (componentId) nodeId = `c:${componentId}`
			else if (component) nodeId = `v:${component.uid}`
			else {
				const identity = vnode.el || vnode
				let id = nativeIds.get(identity)
				if (!id) { id = `n:${uuid()}`; nativeIds.set(identity, id) }
				nodeId = id
			}
			const parent = [...ancestors].reverse().find(node => node.scopeId === ownerId)
			const marks = Object.fromEntries(Object.entries(props).filter(([name]) => name.startsWith('mark:'))
				.map(([name, value]) => [name.slice(5), value]))
			const record = {
				nodeId,
				parentId: parent?.nodeId || `s:${ownerId}`,
				composedParentId: ancestors[ancestors.length - 1]?.nodeId,
				scopeId: ownerId,
				componentId: componentId || undefined,
				virtual: slot || undefined,
				slotOrder: props['dimina-slot-order'] === undefined ? undefined : Number(props['dimina-slot-order']),
				id: props.id || '',
				class: normalizeClass(props.class),
				tag: vnode.type?.__tagName || (typeof vnode.type === 'string' ? vnode.type : ''),
				dataset: getDataAttributes(Object.fromEntries(Object.entries(props).filter(([name]) => (
					!['data-dd-component-host', 'data-dd-style-isolation', 'data-dd-style-host'].includes(name)
				))), value => value),
				marks,
				eventAttr: eventBindings(props),
				properties: component?.props || {},
			}
			if (componentId) record.shadowRootId = `s:${componentId}`
			records.push(record)
			remember(record, vnode)
			nextAncestors = [...ancestors, record]
			if (componentId) {
				const shadow = { nodeId: record.shadowRootId, scopeId: componentId, shadow: true, hostId: nodeId }
				records.push(shadow)
				nextAncestors.push(shadow)
			}
		}
		if (component) walk(component.subTree, nextAncestors)
		else if (vnode.suspense) walk(vnode.suspense.activeBranch, nextAncestors)
		else if (Array.isArray(vnode.children)) for (const child of vnode.children) walk(child, nextAncestors)
	}
	walk(page?.subTree, records.slice(0, 1))
	const tree = new WxmlTree(records)
	return { tree, elements, rendered, records: records.map(({ roots, properties, ...record }) => record) }
}

export function findRenderedNode(snapshot, element, scopeId) {
	for (let current = element; current; current = current.parentElement) {
		const nodes = snapshot.elements.get(current)
		if (nodes?.length) {
			const node = scopeId ? [...nodes].reverse().find(node => node.scopeId === scopeId) : nodes[nodes.length - 1]
			if (node) return node
		}
	}
}
