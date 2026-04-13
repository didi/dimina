import { callback as callbackRegistry, isFunction } from '@dimina/common'
import message from './message'

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
		callbackList.forEach(cb => cb.call(ctx))
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

export function enqueueUpdate(bridgeId, moduleId, data, callbackId) {
	const queue = getQueue(bridgeId)
	const update = queue.byModuleId.get(moduleId)

	if (update) {
		Object.assign(update.data, data)
	}
	else {
		const nextUpdate = { moduleId, data: { ...data } }
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
