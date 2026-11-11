const BINARY = '__diminaArrayBufferBase64'

export function decodeRequestData(value) {
	if (!value || typeof value !== 'object' || typeof value[BINARY] !== 'string') return value
	const encoded = value[BINARY]
	if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
		throw new Error('Invalid binary request data')
	}
	return Buffer.from(encoded, 'base64')
}

export function createRequestResult(response, dataType, responseType) {
	const bytes = Buffer.from(response.data)
	let data
	if (responseType === 'arraybuffer') data = { [BINARY]: bytes.toString('base64') }
	else {
		data = bytes.toString('utf8').replace(/^\uFEFF/, '')
		if (dataType === 'json' && data.length) {
			try { data = JSON.parse(data) } catch { /* Invalid JSON remains text. */ }
		}
	}
	const header = Object.fromEntries(Object.entries(response.headers || {})
		.map(([key, value]) => [key, Array.isArray(value) ? value.join(',') : String(value)]))
	const rawCookies = response.headers?.['set-cookie']
	return { errMsg: 'request:ok', data, statusCode: response.status, header,
		cookies: rawCookies ? (Array.isArray(rawCookies) ? rawCookies : [rawCookies]) : [] }
}
