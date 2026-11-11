import { arrayBufferToBase64 } from '@dimina/common'

const BINARY = '__diminaArrayBufferBase64'

function wireData(data) {
	if (Object.prototype.toString.call(data) === '[object ArrayBuffer]') {
		return { [BINARY]: arrayBufferToBase64(data) }
	}
	if (ArrayBuffer.isView(data)) {
		const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
		return { [BINARY]: arrayBufferToBase64(bytes.slice().buffer) }
	}
	return data
}

/** The host owns its proxy address; container-sdk still requires explicit request registration. */
export function createProxyRequestHandler(proxyUrl) {
	return function request({
		url, data, header = {}, timeout = 60000, method = 'GET',
		dataType = 'json', responseType = 'text', success, fail, complete,
	}) {
		const onSuccess = this.createCallbackFunction(success)
		const onFail = this.createCallbackFunction(fail)
		const onComplete = this.createCallbackFunction(complete)
		fetch(proxyUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ url, data: wireData(data), header, timeout: timeout > 0 ? timeout : 60000,
				method, dataType, responseType: responseType.toLowerCase(), wireEnvelope: true }),
		}).then(async (response) => {
			const result = await response.json()
			if (!response.ok) {
				throw new Error(result.error || response.statusText || 'proxy request failed')
			}
			return result
		}).then((result) => {
			try { onSuccess?.(result) }
			finally { onComplete?.(result) }
		}, (error) => {
			const result = { errMsg: `request:fail ${error.message}` }
			try { onFail?.(result) }
			finally { onComplete?.(result) }
		})
	}
}
