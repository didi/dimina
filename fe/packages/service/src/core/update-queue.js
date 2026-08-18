import { callback as callbackRegistry, isFunction } from '@dimina/common'
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
	const snapshot = JSON.parse(JSON.stringify(encodeDataFunctions({ data, changes: normalizedChanges })))
	return {
		data: snapshot.data || {},
		changes: (snapshot.changes || []).filter(change => Object.prototype.hasOwnProperty.call(change, 'value')),
	}
}

export function enqueueUpdate(bridgeId, moduleId, data, callbackId, changes = []) {
	const queue = getQueue(bridgeId)
	const update = queue.byModuleId.get(moduleId)
	const snapshot = snapshotUpdate(data, changes)

	if (update) {
		Object.assign(update.data, snapshot.data)
		update.changes.push(...snapshot.changes)
	}
	else {
		const nextUpdate = { moduleId, data: snapshot.data, changes: snapshot.changes }
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

	const updates = queue.updates
	const callbackIds = queue.callbackIds
	queue.updates = []
	queue.byModuleId = new Map()
	queue.callbackIds = []
	queue.scheduled = false

	message.send({
		type: 'ub',
		target: 'render',
		body: {
			bridgeId,
			updates,
			callbackIds,
		},
	})
}

export function resetUpdateQueues() {
	queues.clear()
}
