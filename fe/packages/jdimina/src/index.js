import { createFrameTransport } from './frame-transport.js'

function uuid() {
	return Math.random().toString(36).slice(2, 7)
}

const funIdMap = new Map()
const isFunction = v => typeof v === 'function'
const triggerCallback = (id, args) => {
	const fn = funIdMap.get(id)
	funIdMap.delete(id)
	fn?.(args)
}
const frameTransport = createFrameTransport(window, triggerCallback)

if (!frameTransport && window.DiminaRenderBridge) {
	window.DiminaRenderBridge.onMessage = (data) => {
		const { type, body } = data || {}
		if (type === 'triggerCallback' && body?.id) triggerCallback(body.id, body.args)
	}
}

function formatParams(originParams = {}, callBack) {
	const { to, command, data } = originParams

	const funId = isFunction(callBack) ? uuid() : callBack

	isFunction(callBack) && funIdMap.set(funId, callBack)

	const tempTo = (command.split('_') || [])[1] || to || ''

	if (tempTo === 'AppService') {
		let type = (data && data.method) || ''

		if (type.toLowerCase().includes('h5')) {
			type = 'h5SdkAction'
		}

		const body = {
			// method: data.method,
			name: data.method,
			bridgeId: window.embed_webviewId,
			params: {
				data,
				module: data.module,
				success: funId,
				fail: funId,
				// complete: funId, // 不需要
			},
		}

		if (window.embed_webview_data) {
			const { attrs, moduleId, parentWebViewId } = window.embed_webview_data
			attrs && (body.attrs = attrs)
			moduleId && (body.moduleId = moduleId) // js moduleId
			parentWebViewId && (body.parentWebViewId = parentWebViewId)
		}

		return {
			target: 'service',
			type,
			body,
		}
	}
	else if (tempTo === 'Native') {
		return {
			target: 'webview',
			type: 'invokeAPI',
			body: {
				name: data.method,
				bridgeId: window.embed_webviewId,
				params: {
					data,
					module: data.module,
					// 实际消费的是每个回调函数的 uuid
					success: funId,
					fail: funId,
				},
			},
		}
	}
	return false
}

const didiJsBridge = {

	invoke(params, callBack) {
		const finalParams = formatParams(params, callBack)

		if (!finalParams) {
			console.error('didiJsBridge.invoke 参数异常')
			return
		}

		didiJsBridge.onMessage(finalParams)
	},
	// 直接消息传递
	publish() {
		console.warn('publish 未实现')
	},
	onMessage(params = {}) {
		if (frameTransport) frameTransport.invoke(params)
		else window.DiminaRenderBridge.invoke(params)
	},
}

window.wx = window.dd = {
	miniProgram: {},
	openLocation(params) {
		didiJsBridge.invoke(
			{
				command: 'WebView_AppService',
				event: 'H5openLocation',
				to: 'AppService',
				data: {
					latitude: params.latitude,
					longitude: params.longitude,
					name: params.name,
					address: params.address,
					scale: params.scale,
				},
			},
			() => {},
		)
	},
	getLocation(params) {
		didiJsBridge.invoke(
			{
				command: 'WebView_Native',
				to: 'Native',
				data: {
					method: 'getLocation',
					module: 'DMServiceBridgeModule',
					params: {
						type: params.type || 'wgs84',
					},
				},
			},
			(res) => {
				res = res.data
				try {
					if (res.success) {
						if (res.data && typeof res.data === 'object') {
							res.data.errMsg = `${params.event}:ok`
						}
						params.success && params.success(res.data)
					}
					else {
						params.fail && params.fail(res.errMsg)
					}
				}
				finally {
					params.complete && params.complete()
				}
			},
		)
	},
}

const miniProgram = {
	navigateBack(params) {
		const backParams = {
			appId: '1',
			openType: 'navigateBack',
		}
		if (params && params.delta) {
			backParams.delta = params.delta || 1
		}

		didiJsBridge.invoke(
			{
				command: 'WebView_AppService',
				to: 'AppService',
				event: 'H5navigateBack',
				data: {
					module: 'DMServiceBridgeModule',
					method: 'H5navigateBack',
					params: backParams,
				},
			},
			() => {},
		)
	},
	navigateTo(params) {
		didiJsBridge.invoke(
			{
				command: 'WebView_AppService',
				to: 'AppService',
				event: 'H5navigateTo',
				data: {
					module: 'DMServiceBridgeModule',
					method: 'H5navigateTo',
					params: {
						appId: '1',
						url: params.url,
					},
				},
			},
			() => {},
		)
	},
	redirectTo(params) {
		didiJsBridge.invoke(
			{
				command: 'WebView_AppService',
				to: 'AppService',
				event: 'H5redirectTo',
				data: {
					module: 'DMServiceBridgeModule',
					method: 'H5redirectTo',
					params: {
						appId: '1',
						url: params.url,
					},
				},
			},
			() => {},
		)
	},
	switchTab(params) {
		didiJsBridge.invoke(
			{
				command: 'WebView_AppService',
				to: 'AppService',
				event: 'H5switchTab',
				data: {
					module: 'DMServiceBridgeModule',
					method: 'H5switchTab',
					params: {
						appId: '1',
						url: params.url,
						openType: 'switchTab',
					},
				},
			},
			() => {},
		)
	},
	reLaunch(params) {
		didiJsBridge.invoke(
			{
				command: 'WebView_AppService',
				to: 'AppService',
				event: 'H5reLaunch',
				data: {
					module: 'DMServiceBridgeModule',
					method: 'H5reLaunch',
					params: {
						appId: '1',
						url: params.url,
						openType: 'reLaunch',
					},
				},
			},
			() => {},
		)
	},
	postMessage(data) {
		didiJsBridge.invoke({
			command: 'WebView_AppService',
			to: 'AppService',
			event: 'h5postMessage',
			data: {
				module: 'DMServiceBridgeModule',
				method: 'h5postMessage',
				params: {
					appId: '1',
					data: data && data.data,
				},
			},
		})
	},
	getEnv(callBack) {
		didiJsBridge.invoke(
			{
				command: 'WebView_Native',
				to: 'Native',
				event: 'JSBridge',
				data: {
					module: 'DMServiceBridgeModule',
					method: 'getEnv',
					params: {
						appId: '1',
					},
				},
			},
			(res) => {
				const data = res && res.data
				callBack && callBack(data || {})
			},
		)
	},
	goSuperAppTab(tabName, callBack) {
		didiJsBridge.invoke(
			{
				command: 'WebView_AppService',
				event: 'H5goSuperAppTab',
				to: 'AppService',
				data: {
					tabName,
				},
			},
			(res) => {
				callBack && callBack(res)
			},
		)
	},
	getSystemInfo(callBack) {
		didiJsBridge.invoke(
			{
				command: 'WebView_Native',
				to: 'Native',
				event: 'JSBridge',
				data: {
					module: 'DMServiceBridgeModule',
					method: 'getSystemInfo',
				},
			},
			(res) => {
				callBack && callBack(res)
			},
		)
	},
}
window.didiJsBridge = didiJsBridge
window.wx.miniProgram = window.dd.miniProgram = miniProgram
