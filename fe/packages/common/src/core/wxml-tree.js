/** WXML selectors are id/class selectors, not the browser CSS selector grammar. */
export function parseWxmlSelector(selector) {
	const groups = []
	let crossShadow = false
	for (const group of String(selector || '').split(',')) {
		const tokens = []
		let relation = ''
		let valid = true
		for (const part of group.split(/( |\t|>+)/)) {
			if (!part || part === ' ' || part === '\t') continue
			if (part[0] === '>') {
				if (relation) { valid = false; break }
				relation = part
				if (part === '>>>') crossShadow = true
				continue
			}
			const match = part.match(/^(#[_a-zA-Z][-_a-zA-Z0-9:]*|)((?:\.-?[_a-zA-Z][-_a-zA-Z0-9]*)+|)$/)
			if (!match || !match[1] && !match[2]) { valid = false; break }
			tokens.push({ id: match[1].slice(1), classes: match[2].split('.').slice(1), relation })
			relation = ''
		}
		if (valid && tokens.length) groups.push(tokens)
	}
	return groups.length ? { groups, crossShadow } : null
}

/** The same serializable tree is used by Service queries and Render measurements. */
export class WxmlTree {
	constructor(records = []) {
		this.nodes = new Map(records.map(node => [node.nodeId, node]))
		this.children = new Map()
		this.components = new Map()
		for (const node of records) {
			if (node.componentId) this.components.set(node.componentId, node)
			if (node.parentId) {
				const children = this.children.get(node.parentId) || []
				children.push(node)
				this.children.set(node.parentId, children)
			}
		}
		for (const children of this.children.values()) {
			if (children.every(node => Number.isFinite(node.slotOrder))) {
				children.sort((left, right) => left.slotOrder - right.slotOrder)
			}
		}
	}

	parent(node, crossShadow = false) {
		let parent = this.nodes.get(node.parentId)
		while (parent?.virtual) parent = this.nodes.get(parent.parentId)
		if (parent?.shadow) return crossShadow ? this.nodes.get(parent.hostId) : null
		return parent
	}

	within(node, root) {
		for (let parent = this.nodes.get(node.parentId); parent; parent = this.nodes.get(parent.parentId)) {
			if (parent === root) return true
		}
		return false
	}

	matches(node, tokens, root, index = tokens.length - 1) {
		if (!node || node.shadow || node.virtual || node === root) return false
		const token = tokens[index]
		if (token.id && token.id !== node.id) return false
		const classes = new Set(String(node.class || '').split(/\s+/))
		if (token.classes.some(name => !classes.has(name))) return false
		if (index === 0) return this.within(node, root)
		const relation = token.relation
		let parent = this.parent(node, relation === '>>>')
		while (parent && parent !== root) {
			if (this.matches(parent, tokens, root, index - 1)) return true
			if (relation === '>') return false
			parent = this.parent(parent, relation === '>>>')
		}
		return false
	}

	query(moduleId, selector, single = false) {
		const parsed = parseWxmlSelector(selector)
		const root = this.nodes.get(`s:${moduleId}`)
		if (!parsed || !root) return []
		const result = []
		const visit = node => {
			if (!node.shadow && parsed.groups.some(tokens => this.matches(node, tokens, root))) {
				result.push(node)
				if (single) return true
			}
			if (parsed.crossShadow && node.shadowRootId && visit(this.nodes.get(node.shadowRootId))) return true
			for (const child of this.children.get(node.nodeId) || []) if (visit(child)) return true
			return false
		}
		visit(root)
		return result
	}

	collectMarks(node) {
		const marks = {}
		for (let current = node; current; current = this.nodes.get(current.parentId)) {
			for (const [name, value] of Object.entries(current.marks || {})) {
				if (!Object.prototype.hasOwnProperty.call(marks, name)) marks[name] = value
			}
		}
		return marks
	}

	targetInfo(node) {
		return {
			id: node.id || '', dataset: node.dataset || {},
			...(node.offsetLeft !== undefined ? { offsetLeft: node.offsetLeft, offsetTop: node.offsetTop } : {}),
		}
	}

	eventPath(start, composed) {
		const result = []
		let target = start
		let marks = this.collectMarks(target)
		let current = start
		const insertionTargets = []
		const visited = new Set()
		while (current && !visited.has(current.nodeId)) {
			visited.add(current.nodeId)
			if (current.shadow) {
				if (!composed) break
				current = this.nodes.get(current.hostId)
				const saved = insertionTargets.pop()
				target = saved?.target || current
				marks = saved?.marks || this.collectMarks(target)
				continue
			}
			result.push({ node: current, target, mark: marks })
			const logicalParent = this.nodes.get(current.parentId)
			const next = this.nodes.get(composed ? current.composedParentId || current.parentId : current.parentId)
			if (composed && next && next !== logicalParent) {
				// Entering a slot's insertion tree changes the visible target within
				// that shadow root. Restore the light-tree target when leaving it.
				insertionTargets.push({ target, marks })
				target = next
				marks = this.collectMarks(target)
			}
			current = next
		}
		return result
	}
}
