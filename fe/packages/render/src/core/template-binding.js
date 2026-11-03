import { get } from '@dimina/common'

function keyOf(item, key) {
	return key === '*this' ? item : item?.[key]
}

// A keyed component keeps its identity across list replacement and reordering.
// Share the key lookup across the bindings notified by one assignment.
function findIndex(list, scope, keyIndexes) {
	const { key, keyValue } = scope
	const index = !Array.isArray(list) && typeof scope.index === 'number' ? Object.keys(list)[scope.index] : scope.index
	if (!key || (Object.hasOwn(list, index) && keyOf(list[index], key) === keyValue)) return index

	let byKey = keyIndexes.get(list)
	if (!byKey) {
		byKey = new Map()
		keyIndexes.set(list, byKey)
	}
	let indexes = byKey.get(key)
	if (!indexes) {
		indexes = new Map(Object.keys(list).map(index => [keyOf(list[index], key), index]))
		byKey.set(key, indexes)
	}
	return indexes.get(keyValue)
}

function resolvePath(path, aliases) {
	const alias = aliases.get(path[0])
	return alias ? [...alias, ...path.slice(1)] : path
}

function resolveScopes(binding, data, keyIndexes, initializeKeys) {
	const aliases = new Map()
	const indexAliases = new Set()
	const scopeValues = new Map()
	const args = []
	const order = []
	for (const scope of binding.scopes || []) {
		const path = resolvePath(scope.source, aliases)
		const list = get(data, path)
		if (!list || typeof list !== 'object') return
		if (initializeKeys && scope.readKey) {
			const initialIndex = !Array.isArray(list) && typeof scope.index === 'number' ? Object.keys(list)[scope.index] : scope.index
			scope.keyValue = keyOf(list[initialIndex], scope.key)
		}
		const index = findIndex(list, scope, keyIndexes)
		if (index === undefined || !Object.hasOwn(list, index)) return

		const position = Array.isArray(list) ? Number(index) : index
		if (scope.key) scope.index = position
		aliases.set(scope.item, [...path, position])
		indexAliases.delete(scope.item)
		if (scope.indexName) {
			aliases.set(scope.indexName, path)
			indexAliases.add(scope.indexName)
			scopeValues.set(scope.indexName, position)
		}
		scopeValues.set(scope.item, list[index])
		args.push(list[index], position)
		order.push(Array.isArray(list) ? position : Object.keys(list).indexOf(index))
	}
	return { aliases, indexAliases, args: binding.scopeNames ? binding.scopeNames.map(name => scopeValues.get(name)) : args, order }
}

export function initializeTemplateBinding(binding, data) {
	if (binding.scopes?.some(scope => scope.readKey)) resolveScopes(binding, data, new WeakMap(), true)
}

export function resolveTemplateBinding(binding, data, keyIndexes) {
	const scope = resolveScopes(binding, data, keyIndexes)
	if (!scope) return
	const { aliases, indexAliases, args, order } = scope
	const paths = []
	const indexPaths = []
	for (const path of binding.resolvePaths(...args)) {
		(indexAliases.has(path[0]) ? indexPaths : paths).push(resolvePath(path, aliases))
	}
	return { paths, indexPaths, read: () => binding.read(...args), order }
}

// Deep writes to one row only need the bindings registered for that row.
// Structural assignments also inspect the other rows so keyed entries can move.
export class PropertyBindingBucket {
	constructor() {
		this.entries = new Set()
		this.unscoped = new Set()
		this.rows = new Map()
		this.keyFields = new Set()
	}

	add(entry) {
		this.entries.add(entry)
		const scope = entry.binding.scopes?.[0]
		const root = entry.path[0]
		if (scope?.source.length === 1 && scope.source[0] === root
			&& typeof scope.index === 'number' && !entry.binding.dependencies?.includes(root)) {
			if (scope.key) this.keyFields.add(scope.key)
			if (entry.binding.scopes.length === 1 && entry.binding.dependencyPaths) {
				entry.rowDependencies = entry.binding.dependencyPaths
					.filter(path => path[0] === scope.item)
					.map(path => path.slice(1))
			}
			this.move(entry, scope.index)
		}
		else {
			this.unscoped.add(entry)
		}
	}

	move(entry, index) {
		if (entry.row === index) return
		this.removeRow(entry)
		entry.row = index
		let rows = this.rows.get(index)
		if (!rows) {
			rows = new Set()
			this.rows.set(index, rows)
		}
		rows.add(entry)
	}

	removeRow(entry) {
		const entries = this.rows.get(entry.row)
		if (!entries) return
		entries.delete(entry)
		if (entries.size === 0) this.rows.delete(entry.row)
	}

	delete(entry) {
		this.entries.delete(entry)
		this.unscoped.delete(entry)
		this.removeRow(entry)
	}

	*candidates(path) {
		const index = path[1]
		if (path.length < 3 || !/^\d+$/.test(index) || this.keyFields.has(path[2])) {
			yield* this.entries
		}
		else {
			yield* this.unscoped
			for (const entry of this.rows.get(Number(index)) || []) {
				if (!entry.rowDependencies || entry.rowDependencies.some(dependency => (
					dependency.every((part, i) => i + 2 >= path.length || String(part) === String(path[i + 2]))
				))) yield entry
			}
		}
	}
}
