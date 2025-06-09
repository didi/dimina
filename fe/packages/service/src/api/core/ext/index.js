import { isFunction } from '@dimina/common'
import { invokeAPI } from '@/api/common'
import message from '@/core/message'

/**
 * 第三方拓展的 bridge 接口
 */
export function extBridge({ event, module, data = {}, success, fail, complete }, extraCallback) {
	let overrideSuccess
	let overrideFail
	let overrideComplete

	if (isFunction(extraCallback)) {
		overrideSuccess = extraCallback
		overrideFail = extraCallback
	}
	else {
		overrideSuccess = success
		overrideFail = fail
		overrideComplete = complete
	}

	invokeAPI(event, {
		module,
		data,
		keep: data.isSustain ?? true,
		success: overrideSuccess,
		fail: overrideFail,
		complete: overrideComplete,
	})
}

/**
 * 第三方扩展的 on 接口
 */
export function extOnBridge({ event, module, callBack, isSustain = true }) {
	if (!module || module === 'DMServiceBridgeModule') {
		console.error(`[ERROR]: extOnBridge \u53C2\u6570 module ${module ? `\u503C${module}\u4E0D\u5408\u6CD5` : '为空'}`)
		return
	}

	if (!event) {
		console.error('[ERROR]: extOnBridge 参数 event 为空')
		return
	}

	if (!callBack) {
		console.error('[ERROR]: extOnBridge 参数 callBack 为空')
		return
	}

	const eventName = `${module}_${event}`

	invokeAPI(eventName, {
		keep: isSustain,
		success: callBack,
	})
}

/**
 * 第三方扩展的 off 接口
 */
export function extOffBridge({ event, module, callBack }) {
	if (!module || module === 'DMServiceBridgeModule') {
		console.error(`[ERROR]: extOffBridge \u53C2\u6570 module ${module ? `\u503C${module}\u4E0D\u5408\u6CD5` : '为空'}`)
		return
	}

	if (!event) {
		console.error('[ERROR]: extOffBridge 参数 event 为空')
		return
	}

	const eventName = `${module}_${event}`

	invokeAPI(eventName, {
		success: callBack,
	})
}

/**
 * 登录状态变化时的回调
 */
export function onLoginStatusChanged(callback) {
	message.on('notifyLoginStatusChanged', (msg) => {
		callback?.(msg)
	})
}

/**
 * 取消登录状态变化时的回调
 */
export function offLoginStatusChanged() {
	message.off('notifyLoginStatusChanged')
}
