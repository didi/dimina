// A sequence whose entries can move without renumbering the rest of the list.
export class LinkedOrder {
	constructor(values) {
		this.ends = {}
		this.ends.next = this.ends.prev = this.ends
		this.nodes = new Map()
		for (const value of values) this.insertBefore(value)
	}

	has(value) {
		return this.nodes.has(value)
	}

	next(value) {
		return this.nodes.get(value)?.next.value
	}

	remove(value) {
		const node = this.nodes.get(value)
		if (!node) return
		node.prev.next = node.next
		node.next.prev = node.prev
		this.nodes.delete(value)
	}

	insertBefore(value, before) {
		if (value === before) return
		this.remove(value)
		const next = this.nodes.get(before) || this.ends
		const node = { value, prev: next.prev, next }
		next.prev.next = node
		next.prev = node
		this.nodes.set(value, node)
	}

	*[Symbol.iterator]() {
		for (let node = this.ends.next; node !== this.ends; node = node.next) yield node.value
	}
}
