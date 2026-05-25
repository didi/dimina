import { callback, isFunction } from '@dimina/common'
import hostEnv from '../../core/host-env'
import message from '../../core/message'
import router from '../../core/router'

const hostEnvResolvers = {
	getWindowInfo: () => hostEnv.getSystemInfo(),
	getSystemInfoSync: () => hostEnv.getSystemInfo(),
	getAppBaseInfo: () => hostEnv.getSystemInfo(),
	getDeviceInfo: () => hostEnv.getSystemInfo(),
	getMenuButtonBoundingClientRect: () => hostEnv.getMenuRect(),
}

export function invokeAPI(name, data, target = 'container') {
	const resolveFromHostEnv = hostEnvResolvers[name]
	if (target === 'container' && resolveFromHostEnv) {
		const cachedValue = resolveFromHostEnv()
		if (cachedValue) {
			return cachedValue
		}
	}

	let params
	if (data === undefined || typeof data === 'string' || Array.isArray(data)) {
		params = data
	}
	else if (isFunction(data)) {
		params = {
			success: callback.store(data, true),
		}
	}
	else if (Object.prototype.hasOwnProperty.call(data, 'success') || Object.prototype.hasOwnProperty.call(data, 'fail') || Object.prototype.hasOwnProperty.call(data, 'complete')) {
		const { success, fail, complete, keep, evtId, ...rest} = data

		params = rest

		if (isFunction(success)) {
			params.success = callback.store(success, keep, evtId)
		}
		else {
			params.success = success
		}

		if (isFunction(fail)) {
			params.fail = callback.store(fail, keep, evtId)
		}

		if (isFunction(complete)) {
			params.complete = callback.store(complete, keep, evtId)
		}
	}
	else {
		const { keep, evtId, ...rest } = data
		if (!keep) {
			params = { ...rest }
			return new Promise((resolve) => {
				params.success = callback.store((res) => resolve(res))
				params.fail = callback.store((res) => resolve(res))
				const msg = {
					type: 'invokeAPI',
					target,
					body: {
						name,
						bridgeId: router.getPageInfo().id,
						params,
					},
				}
				if (target === 'container') {
					message.invoke(msg)
				}
				else {
					message.send(msg)
				}
			})
		}
		params = rest
	}

	const msg = {
		type: 'invokeAPI',
		target,
		body: {
			name,
			bridgeId: router.getPageInfo().id,
			params,
		},
	}
	if (target === 'container') {
		return message.invoke(msg)
	}
	else {
		return message.send(msg)
	}
}
