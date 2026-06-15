import { callback, isFunction } from '@dimina/common'
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

function invokePromiseAPI(name, params, target) {
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

export function invokeAPI(name, data, target = 'container') {
	const resolveFromHostEnv = hostEnvResolvers[name]
	if (target === 'container' && resolveFromHostEnv) {
		const cachedValue = resolveFromHostEnv()
		if (cachedValue) {
			return cachedValue
		}
	}

	let params
	if (data === undefined) {
		if (canReturnPromise(name, data)) {
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
		const { keep, ...rest } = data
		delete rest.evtId
		if (!keep && canReturnPromise(name, data)) {
			params = { ...rest }
			return invokePromiseAPI(name, params, target)
		}
		params = rest
	}

	return invokeMessage(name, params, target)
}
