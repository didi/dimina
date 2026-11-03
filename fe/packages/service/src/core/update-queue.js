import { callback as callbackRegistry, isFunction, mayContainDataFunctionReferences } from '@dimina/common'
import { parseDataPath } from './data-update'
import { encodeDataFunctions } from './data-function'
import message from './message'
import { invokeSafely } from './safe-callback'

const queues = new Map()

function getQueue(bridgeId) {
	if (!queues.has(bridgeId)) {
		queues.set(bridgeId, {
			depth: 0,
			scheduled: false,
			updates: [],
			byModuleId: new Map(),
			callbackIds: [],
			hasDataFunctions: false,
		})
	}

	return queues.get(bridgeId)
}

export function createUpdateCallback(ctx, callbacks) {
	const callbackList = (Array.isArray(callbacks) ? callbacks : [callbacks]).filter(isFunction)
	if (callbackList.length === 0) {
		return undefined
	}

	return callbackRegistry.store(() => {
		callbackList.forEach(cb => invokeSafely(ctx, cb, [], 'setData callback'))
	})
}

export function beginUpdateBatch(bridgeId) {
	const queue = getQueue(bridgeId)
	queue.depth++
}

export function endUpdateBatch(bridgeId) {
	const queue = getQueue(bridgeId)
	if (queue.depth > 0) {
		queue.depth--
	}
	if (queue.depth === 0) {
		flushUpdates(bridgeId)
	}
}

function snapshotUpdate(data, changes = []) {
	const normalizedChanges = changes.length > 0
		? changes
		: Object.entries(data).flatMap(([key, value]) => {
			const path = parseDataPath(key)
			return path ? [{ path, value }] : []
		})
	const json = JSON.stringify(encodeDataFunctions(normalizedChanges))
	const ordered = JSON.parse(json).filter(change => Object.hasOwn(change, 'value'))
	// Render applies only the ordered changes when they are present.
	if (ordered.length) return [{ changes: ordered }, mayContainDataFunctionReferences(json)]

	const fallback = JSON.stringify(encodeDataFunctions(data ?? {}))
	return [{ data: JSON.parse(fallback) || {}, changes: [] }, mayContainDataFunctionReferences(fallback)]
}

export function enqueueUpdate(bridgeId, moduleId, data, callbackId, changes = [], syncedChildren) {
	const queue = getQueue(bridgeId)
	const update = queue.byModuleId.get(moduleId)
	const [snapshot, hasDataFunctions] = snapshotUpdate(data, changes)
	queue.hasDataFunctions ||= hasDataFunctions
	if (syncedChildren && snapshot.changes.length) {
		const start = update?.changes.length || 0
		// Ranges keep separate setData calls distinct after the per-module queue is merged.
		const assignment = [start, start + snapshot.changes.length]
		if (syncedChildren.length) {
			assignment.push(Object.fromEntries(syncedChildren.map(({ child, data }) => [child.__id__, Object.keys(data)])))
		}
		snapshot.propertyAssignments = [assignment]
	}

	if (update) {
		update.changes.push(...snapshot.changes)
		if (update.changes.length) delete update.data
		else Object.assign(update.data, snapshot.data)
		if (snapshot.propertyAssignments) {
			update.propertyAssignments ||= []
			update.propertyAssignments.push(...snapshot.propertyAssignments)
		}
	}
	else {
		const nextUpdate = { moduleId, ...snapshot }
		queue.byModuleId.set(moduleId, nextUpdate)
		queue.updates.push(nextUpdate)
	}

	if (callbackId) {
		queue.callbackIds.push(callbackId)
	}

	if (queue.depth === 0 && !queue.scheduled) {
		queue.scheduled = true
		Promise.resolve().then(() => {
			queue.scheduled = false
			if (queue.depth === 0) {
				flushUpdates(bridgeId)
			}
		})
	}
}

export function flushUpdates(bridgeId) {
	const queue = queues.get(bridgeId)
	if (!queue || queue.updates.length === 0) {
		return
	}

	const { updates, hasDataFunctions } = queue
	const callbackIds = queue.callbackIds
	queue.updates = []
	queue.byModuleId = new Map()
	queue.callbackIds = []
	queue.hasDataFunctions = false
	queue.scheduled = false

	message.send({
		type: 'ub',
		target: 'render',
		body: {
			bridgeId,
			updates,
			callbackIds,
			hasDataFunctions,
		},
	}, true)
}

export function resetUpdateQueues() {
	queues.clear()
}
