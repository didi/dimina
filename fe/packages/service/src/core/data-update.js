import { cloneDeep, get, isFunction, isString } from '@dimina/common'
import { invokeSafely } from './safe-callback'

/**
 * Parse a mini-program setData path.
 *
 * Unlike lodash paths, brackets only accept array indexes. Dots and brackets
 * can be used as literal key characters when escaped with a backslash.
 */
export function parseDataPath(path) {
	if (typeof path !== 'string' || path.length === 0) {
		return null
	}

	const parts = []
	let token = ''
	let index = 0

	const pushToken = () => {
		if (token.length > 0) {
			parts.push(token)
			token = ''
		}
	}

	while (index < path.length) {
		const char = path[index]

		if (char === '\\') {
			const escaped = path[index + 1]
			if (escaped === '.' || escaped === '[' || escaped === ']' || escaped === '\\') {
				token += escaped
				index += 2
				continue
			}
			token += char
			index++
			continue
		}

		if (char === '.') {
			pushToken()
			index++
			continue
		}

		if (char === '[') {
			if (parts.length === 0 && token.length === 0) {
				return null
			}
			pushToken()
			const closingIndex = path.indexOf(']', index + 1)
			if (closingIndex === -1) {
				return null
			}
			const arrayIndex = path.slice(index + 1, closingIndex)
			if (!/^\d+$/.test(arrayIndex)) {
				return null
			}
			parts.push(Number(arrayIndex))
			index = closingIndex + 1
			continue
		}

		if (char === ']') {
			return null
		}

		token += char
		index++
	}

	pushToken()
	return parts.length > 0 ? parts : null
}

export function setDataPathValue(target, path, value) {
	let current = target
	for (let index = 0; index < path.length - 1; index++) {
		const key = path[index]
		const nextKey = path[index + 1]
		const hasOwnValue = Object.prototype.hasOwnProperty.call(current, key)
		if (typeof nextKey === 'number') {
			if (!hasOwnValue || !Array.isArray(current[key])) {
				current[key] = []
			}
		}
		else if (!hasOwnValue || current[key] === null || typeof current[key] !== 'object' || Array.isArray(current[key])) {
			current[key] = {}
		}
		current = current[key]
	}
	current[path[path.length - 1]] = value
}

function isPathPrefix(prefix, path) {
	return prefix.length <= path.length && prefix.every((part, index) => part === path[index])
}

function parseObserverExpression(expression) {
	const paths = expression.split(',').map(item => item.trim()).filter(Boolean)
	const parsedPaths = []

	for (const path of paths) {
		if (path === '**') {
			parsedPaths.push({ path: [], wildcard: true })
			continue
		}

		const wildcard = path.endsWith('.**')
		const parsed = parseDataPath(wildcard ? path.slice(0, -3) : path)
		if (parsed) {
			parsedPaths.push({ path: parsed, wildcard })
		}
	}

	return parsedPaths
}

function observerPathMatches(observerPath, changedPath) {
	if (observerPath.wildcard && observerPath.path.length === 0) {
		return true
	}
	if (observerPath.wildcard) {
		return isPathPrefix(observerPath.path, changedPath) || isPathPrefix(changedPath, observerPath.path)
	}
	// exparser only treats an exact observer as affected when its own path (or
	// one of its ancestors) is assigned. Descendant assignments require `.**`.
	return isPathPrefix(changedPath, observerPath.path)
}

function getObserverDescriptors(info) {
	const descriptors = []

	if (Array.isArray(info.behaviorObserverList) && info.behaviorObserverList.length > 0) {
		for (const { key, observer } of info.behaviorObserverList) {
			descriptors.push({ expression: key, observer })
		}
	}
	else {
		for (const [expression, observers] of Object.entries(info.behaviorObservers || {})) {
			for (const observer of observers || []) {
				descriptors.push({ expression, observer })
			}
		}
	}

	for (const [expression, observer] of Object.entries(info.observers || {})) {
		descriptors.push({ expression, observer })
	}

	return descriptors.map(descriptor => ({
		...descriptor,
		paths: parseObserverExpression(descriptor.expression),
	}))
}

/** Invoke matching data observers once, in their registration order. */
export function invokeDataObservers(ctx, changedPaths, data = ctx.data, info = ctx.__info__ || {}) {
	for (const descriptor of getObserverDescriptors(info)) {
		if (!isFunction(descriptor.observer)) {
			continue
		}
		if (!descriptor.paths.some(path => changedPaths.some(changedPath => observerPathMatches(path, changedPath)))) {
			continue
		}

		const args = descriptor.paths.map(({ path }) => path.length === 0 ? data : get(data, path))
		invokeSafely(ctx, descriptor.observer, args, 'data observer')
	}
}

function makeChangedData(ctx, changes) {
	const changedData = {}
	for (const change of changes) {
		changedData[change.key] = get(ctx.data, change.path)
	}
	return changedData
}

function collectPropertyChanges(ctx, changes) {
	const properties = ctx.__info__?.properties || {}
	return changes.flatMap(change => {
		const propertyName = change.path[0]
		if (typeof propertyName !== 'string' || !Object.prototype.hasOwnProperty.call(properties, propertyName)) {
			return []
		}
		return [{
			propertyName,
			oldValue: change.path.length === 1 ? change.oldValue : undefined,
			path: change.path,
			value: change.value,
		}]
	})
}

/**
 * Apply one setData transaction. setData calls made by a data observer join the
 * same transaction and are drained in a following observer pass.
 */
export function applyDataUpdates(ctx, data, callback) {
	if (!data || typeof data !== 'object' || Array.isArray(data)) {
		console.warn('[service] setData data must be an object')
		return null
	}

	const outermost = !ctx.__dataUpdateTransaction__
	const transaction = ctx.__dataUpdateTransaction__ || {
		changes: [],
		pendingPaths: [],
		callbacks: [],
	}
	ctx.__dataUpdateTransaction__ = transaction

	if (isFunction(callback)) {
		transaction.callbacks.push(callback)
	}

	for (const key of Object.keys(data)) {
		const path = parseDataPath(key)
		if (!path) {
			console.warn(`[service] invalid setData path: ${key}`)
			continue
		}

		let value = cloneDeep(data[key])
		if (path.length === 1 && ctx.__propertySchemas__?.[path[0]] && isFunction(ctx.normalizePropertyValues)) {
			value = ctx.normalizePropertyValues({ [path[0]]: value })[path[0]]
		}
		const oldValue = path.length === 1 ? ctx.data[path[0]] : undefined
		setDataPathValue(ctx.data, path, value)
		transaction.changes.push({ key, path, oldValue, value })
		transaction.pendingPaths.push(path)
	}

	if (!outermost) {
		return null
	}

	try {
		while (transaction.pendingPaths.length > 0) {
			const changedPaths = transaction.pendingPaths
			transaction.pendingPaths = []
			invokeDataObservers(ctx, changedPaths)
		}
	}
	finally {
		delete ctx.__dataUpdateTransaction__
	}

	return {
		callbacks: transaction.callbacks,
		changedData: makeChangedData(ctx, transaction.changes),
		changes: transaction.changes.map(change => ({
			path: change.path,
			value: change.value,
		})),
		propertyChanges: collectPropertyChanges(ctx, transaction.changes),
	}
}

export function invokePropertyChanges(ctx, propertyChanges) {
	const properties = ctx.__info__?.properties || {}

	for (const change of propertyChanges) {
		const definition = properties[change.propertyName]
		const observer = definition?.observer
		const path = change.path
		const value = Object.prototype.hasOwnProperty.call(change, 'value')
			? change.value
			: (path.length === 1 ? ctx.data[change.propertyName] : get(ctx.data, path))
		if (path.length === 1 && value === change.oldValue && !definition?.observeAssignments) {
			continue
		}

		if (isString(observer)) {
			invokeSafely(ctx, ctx[observer], [value, change.oldValue, path], 'property observer')
		}
		else if (isFunction(observer)) {
			invokeSafely(ctx, observer, [value, change.oldValue, path], 'property observer')
		}
	}
}
