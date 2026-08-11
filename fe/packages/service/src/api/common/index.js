import { callback, isFunction, isNil } from '@dimina/common'
import hostEnv from '../../core/host-env'
import message from '../../core/message'
import router from '../../core/router'

function pick(obj, keys) {
    if (!obj) return obj;
    const result = {};
    for (const key of keys) {
        if (key in obj) result[key] = obj[key];
    }
    return result;
}

const hostEnvResolvers = {
    getWindowInfo: () =>
        pick(hostEnv.getSystemInfo(), [
            "pixelRatio",
            "screenWidth",
            "screenHeight",
            "windowWidth",
            "windowHeight",
            "statusBarHeight",
            "safeArea",
            "screenTop",
        ]),
    getSystemInfoSync: () => hostEnv.getSystemInfo(),
    getAppBaseInfo: () =>
        pick(hostEnv.getSystemInfo(), [
            "SDKVersion",
            "enableDebug",
            "host",
            "language",
            "version",
            "theme",
            "fontSizeScaleFactor",
            "fontSizeSetting",
        ]),
    getDeviceInfo: () =>
        pick(hostEnv.getSystemInfo(), [
            "abi",
            "benchmarkLevel",
            "brand",
            "model",
            "platform",
            "system",
        ]),
    getMenuButtonBoundingClientRect: () => hostEnv.getMenuRect(),
};

const promiseUnsupportedApis = new Set([
	'connectSocket',
	'downloadFile',
	'loadSubpackage',
	'preDownloadSubpackage',
	'request',
	'uploadFile',
])

const optionalParamPromiseApis = new Set([
	'FileSystemManager.getSavedFileList',
	'clearStorage',
	'closeSocket',
	'chooseImage',
	'chooseMedia',
	'chooseVideo',
	'closeBluetoothAdapter',
	'getClipboardData',
	'getBluetoothAdapterState',
	'getBluetoothDevices',
	'getLocation',
	'getNetworkType',
	'getPrivacySetting',
	'getStorageInfo',
	'getSystemInfo',
	'getSystemInfoAsync',
	'getUserInfo',
	'hideKeyboard',
	'hideLoading',
	'hideShareMenu',
	'hideTabBar',
	'hideToast',
	'login',
	'navigateBack',
	'openAppAuthorizeSetting',
	'openBluetoothAdapter',
	'openSetting',
	'openSystemBluetoothSetting',
	'showNavigationBarLoading',
	'showShareMenu',
	'showTabBar',
	'startPullDownRefresh',
	'startRecord',
	'stopPullDownRefresh',
	'stopBluetoothDevicesDiscovery',
	'stopLocationUpdate',
	'stopRecord',
	'vibrateLong',
	'vibrateShort',
])

function hasCallbackField(data) {
	return Object.prototype.hasOwnProperty.call(data, 'success')
		|| Object.prototype.hasOwnProperty.call(data, 'fail')
		|| Object.prototype.hasOwnProperty.call(data, 'complete')
}

function canReturnPromise(name, data) {
	if (promiseUnsupportedApis.has(name) || (typeof name === 'string' && name.endsWith('Sync'))) {
		return false
	}
	if (data === undefined) {
		return optionalParamPromiseApis.has(name)
	}
	return true
}

function invokeMessage(name, params, target) {
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

export function invokePromiseAPI(name, params, target) {
	return new Promise((resolve, reject) => {
		let successId
		let failId
		const cleanup = () => {
			callback.remove(successId)
			callback.remove(failId)
		}
		successId = callback.store((res) => {
			cleanup()
			resolve(res)
		})
		failId = callback.store((res) => {
			cleanup()
			reject(res)
		})
		params.success = successId
		params.fail = failId
		try {
			invokeMessage(name, params, target)
		}
		catch (error) {
			cleanup()
			reject(error)
		}
	})
}

/**
 * 一次接口调用只会走 success 或 fail 其中一条，回调表只在回调真正触发时才回收条目，
 * 没走的那条就永久留在表里，连带闭包捕获的对象一起留住。这里把两条成对登记，任一条
 * 触发时把两条都摘掉。
 *
 * 调用方只给了其中一条时，另一条也登记一个只做清理的空回调——不然原生正好走的是没
 * 登记的那一边，就没有任何东西能触发清理，漏的还是同一条。
 */
function storeSettlerPair(params, success, fail) {
	let successId
	let failId
	const settle = () => {
		callback.remove(successId)
		callback.remove(failId)
	}

	successId = callback.store((res) => {
		settle()
		if (isFunction(success)) {
			success(res)
		}
	})
	failId = callback.store((res) => {
		settle()
		if (isFunction(fail)) {
			fail(res)
		}
	})

	params.success = successId
	params.fail = failId
}

// 空字符串不是有效的回调 id，跟没传一个意思。
function isAbsentSettler(value) {
	return isNil(value) || value === ''
}

/**
 * success / fail 能不能成对登记。
 * keep 是事件订阅，会反复触发，摘掉就收不到后续事件了；evtId 是扩展订阅，三个回调
 * 共用同一个 id，成对登记会把它们打乱；调用方直接传回调 id 字符串时也不能替换成
 * 新登记的 id。
 */
function canPairSettlers({ success, fail, keep, evtId }) {
	if (keep || evtId !== undefined) {
		return false
	}
	if (!isFunction(success) && !isFunction(fail)) {
		return false
	}
	return (isFunction(success) || isAbsentSettler(success)) && (isFunction(fail) || isAbsentSettler(fail))
}

export function invokeAPI(name, data, target = 'container', allowPromise = true) {
	const resolveFromHostEnv = hostEnvResolvers[name]
	if (target === 'container' && resolveFromHostEnv) {
		const cachedValue = resolveFromHostEnv()
		if (cachedValue) {
			return cachedValue
		}
	}

	let params
	// 这次调用新建的一次性回调 id。桥没送出去的话它们一条都不会再被触发，留在
	// 回调表里就是永久残留，所以下发失败时要按这份清单摘掉。
	// 两类登记刻意不进这份清单，因为摘掉的可能不是本次调用独占的条目：
	// 常驻登记按函数身份去重，拿回来的可能是上一次成功登记的那个 id；调用方指定
	// 了 evtId 的，那个 id 可能早就被别人占着，本次只是覆盖了它。
	const disposableIds = []
	if (data === undefined) {
		if (allowPromise && canReturnPromise(name, data)) {
			return invokePromiseAPI(name, {}, target)
		}
		params = data
	}
	else if (typeof data === 'string' || Array.isArray(data)) {
		params = data
	}
	else if (isFunction(data)) {
		params = {
			success: callback.store(data, true),
		}
	}
	else if (hasCallbackField(data)) {
		const { success, fail, complete, keep, evtId, ...rest } = data

		params = rest
		if (evtId !== undefined) {
			// 扩展订阅通过 evtId 与普通带 success 的 API 调用区分。
			params.evtId = evtId
		}

		if (canPairSettlers({ success, fail, keep, evtId })) {
			storeSettlerPair(params, success, fail)
			disposableIds.push(params.success, params.fail)
		}
		else {
			const disposable = !keep && evtId === undefined

			if (isFunction(success)) {
				params.success = callback.store(success, keep, evtId)
				if (disposable) {
					disposableIds.push(params.success)
				}
			}
			else {
				params.success = success
			}

			if (isFunction(fail)) {
				params.fail = callback.store(fail, keep, evtId)
				if (disposable) {
					disposableIds.push(params.fail)
				}
			}
			else {
				params.fail = fail
			}
		}

		if (isFunction(complete)) {
			params.complete = callback.store(complete, keep, evtId)
			if (!keep && evtId === undefined) {
				disposableIds.push(params.complete)
			}
		}
		else {
			params.complete = complete
		}
	}
	else {
		const { keep, ...rest } = data
		delete rest.evtId
		if (!keep && allowPromise && canReturnPromise(name, data)) {
			params = { ...rest }
			return invokePromiseAPI(name, params, target)
		}
		params = rest
	}

	try {
		return invokeMessage(name, params, target)
	}
	catch (error) {
		for (const id of disposableIds) {
			callback.remove(id)
		}
		throw error
	}
}

// SocketTask 的实例方法在微信中固定返回 void，不能因为调用方没传 success/fail 就走
// 通用 API 的 Promise 分支。这个入口只给这类 callback-only API 的内部实现使用。
export function invokeAPIWithoutPromise(name, data, target = 'container') {
	return invokeAPI(name, data, target, false)
}
