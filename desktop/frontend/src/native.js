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
	invokeHostApi: (method, params) => call('InvokeHostApi', method, params),
}

const registrations = new WeakMap()

function registrationFor(container) {
    let registration = registrations.get(container)
    if (!registration) {
        registration = { desktop: new Map(), host: new Set() }
        registrations.set(container, registration)
    }
    return registration
}

function registerDesktopApi(container, name, handler) {
    registrationFor(container).desktop.set(name, handler)
    container.registerApi(name, handler)
}

function containerFallback(name) {
    return function(params = {}) {
        const fallback = this[name]
        if (typeof fallback === 'function') return fallback.call(this, params)
        const result = { errMsg: `${name}:fail API is not supported on desktop` }
        try { this.createCallbackFunction(params.fail)?.(result) }
        finally { this.createCallbackFunction(params.complete)?.(result) }
    }
}

export function registerHostApis(container, names = []) {
    const registration = registrationFor(container)
    const next = new Set(names)
    for (const name of registration.host) {
        if (!next.has(name)) container.registerApi(name, registration.desktop.get(name) || containerFallback(name))
    }
    registration.host = next

	for (const name of names) container.registerApi(name, function(params = {}) {
		const success = this.createCallbackFunction(params.success)
		const fail = this.createCallbackFunction(params.fail)
		const complete = this.createCallbackFunction(params.complete)
		const { success: _success, fail: _fail, complete: _complete, ...payload } = params
		Promise.resolve().then(() => desktop.invokeHostApi(name, payload)).then(value => {
			const result = { ...value, errMsg: typeof value?.errMsg === 'string' && value.errMsg ? value.errMsg : `${name}:ok` }
			try {
				if (result.errMsg.endsWith(':ok')) success?.(result)
				else fail?.(result)
			} finally { complete?.(result) }
		}, error => {
			const result = { errMsg: `${name}:fail ${error.message || error}` }
			try { fail?.(result) } finally { complete?.(result) }
		})
	})
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
		data = { __diminaArrayBufferBase64: result.base64 }
	}
	else if ((params.dataType || 'json').toLowerCase() === 'json') {
		try { data = JSON.parse(data) }
		catch { /* wx.request returns the original text when JSON parsing fails. */ }
	}
	return { data, statusCode: result.statusCode, header: Object.fromEntries(Object.entries(result.header).map(([key, value]) => [key, value.join(', ')])) }
}

export function registerDesktopApis(container, runtimeApis = []) {
	const methods = ['request', 'setClipboardData', 'getClipboardData', 'chooseMessageFile', 'scanCode', 'navigateToMiniProgram', 'navigateBackMiniProgram',
		'setStorage', 'getStorage', 'removeStorage', 'clearStorage', 'getStorageInfo', ...runtimeApis]
	for (const name of new Set(methods)) {
        if (/^(on|off)[A-Z]/.test(name.split('.').at(-1))) {
            registerDesktopApi(container, name, function(params = {}) {
                desktop.invoke(name, params).catch(error => console.error(`[desktop] ${name}:`, error))
            })
            continue
        }
		registerDesktopApi(container, name, function (params = {}) {
			const success = this.createCallbackFunction(params.success)
			const fail = this.createCallbackFunction(params.fail)
			const complete = this.createCallbackFunction(params.complete)
			const { success: _success, fail: _fail, complete: _complete, ...payload } = params
			desktop.invoke(name, name === 'request' ? requestParams(payload) : payload).then((value) => {
				const result = { ...(name === 'request' ? requestResult(value, payload) : value), errMsg: value?.errMsg || `${name}:ok` }
				try { if (result.errMsg.endsWith(':ok')) success?.(result); else fail?.(result) }
				finally { complete?.(result) }
			}, (error) => {
				const result = { errMsg: `${name}:fail ${error.message || error}` }
				try { fail?.(result) }
				finally { complete?.(result) }
			})
		})
	}
}

export function dispatchRuntimeEvent(app, event) {
    if (typeof event?.callbackId === 'string') app.createCallbackFunction(event.callbackId)?.(event.value)
}
