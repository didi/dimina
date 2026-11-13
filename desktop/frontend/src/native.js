const call = (method, ...args) => {
	if (!window.mygo?.call) throw new Error('请从 Dimina Desktop 打开此页面')
	return window.mygo.call(`Desktop.${method}`, ...args)
}

export const desktop = {
	bootstrap: () => call('Bootstrap'),
	listApps: () => call('ListApps'),
	importApp: () => call('ImportApp'),
	openApp: appId => call('OpenApp', appId),
	presentWindow: () => call('PresentWindow'),
	prepareToClose: () => call('PrepareToClose'),
	runtimeReady: () => call('RuntimeReady'),
	runtimeFailed: message => call('RuntimeFailed', message),
	invoke: (method, params) => call('Invoke', method, params),
}

function toBase64(data) {
	const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
	let binary = ''
	for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
	return btoa(binary)
}

function requestParams(params) {
	const data = params.data
	return {
		...params,
		data: data instanceof ArrayBuffer || ArrayBuffer.isView(data) ? { __diminaArrayBufferBase64: toBase64(data) } : data,
	}
}

function requestResult(result, params) {
	let data = result.data
	if (params.responseType?.toLowerCase() === 'arraybuffer') {
		data = Uint8Array.from(atob(result.base64), c => c.charCodeAt(0)).buffer
	}
	else if ((params.dataType || 'json').toLowerCase() === 'json') {
		try { data = JSON.parse(data) }
		catch { /* wx.request returns the original text when JSON parsing fails. */ }
	}
	return { data, statusCode: result.statusCode, header: Object.fromEntries(Object.entries(result.header).map(([key, value]) => [key, value.join(', ')])) }
}

export function registerDesktopApis(container) {
	const methods = ['request', 'setClipboardData', 'getClipboardData', 'chooseMessageFile', 'navigateToMiniProgram', 'navigateBackMiniProgram',
		'setStorage', 'getStorage', 'removeStorage', 'clearStorage', 'getStorageInfo']
	for (const name of methods) {
		container.registerApi(name, function (params = {}) {
			const success = this.createCallbackFunction(params.success)
			const fail = this.createCallbackFunction(params.fail)
			const complete = this.createCallbackFunction(params.complete)
			const { success: _success, fail: _fail, complete: _complete, ...payload } = params
			desktop.invoke(name, name === 'request' ? requestParams(payload) : payload).then((value) => {
				const result = { ...(name === 'request' ? requestResult(value, payload) : value), errMsg: `${name}:ok` }
				try { success?.(result) }
				finally { complete?.(result) }
			}, (error) => {
				const result = { errMsg: `${name}:fail ${error.message || error}` }
				try { fail?.(result) }
				finally { complete?.(result) }
			})
		})
	}
}
