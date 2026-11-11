import { debugRequest } from '../../../../core/debug'
import { invokeAPI } from '@/api/common'
import { ARRAY_BUFFER_BASE64_KEY, base64ToArrayBuffer, encodeSocketMessage } from '../socket/shared'

function prepareBinaryRequest(options) {
	if (!options || typeof options !== 'object') return options
	const data = encodeSocketMessage(options.data)
	const binaryResponse = options.responseType?.toLowerCase() === 'arraybuffer'
	if (data === options.data && !binaryResponse) return options
	const result = { ...options, ...(data !== options.data ? { data } : {}) }
	if (binaryResponse) {
		for (const name of ['success', 'complete']) {
			if (typeof options[name] !== 'function') continue
			result[name] = (response) => {
				const value = response?.data
				const decoded = value && typeof value[ARRAY_BUFFER_BASE64_KEY] === 'string'
					? { ...response, data: base64ToArrayBuffer(value[ARRAY_BUFFER_BASE64_KEY]) }
					: response
				options[name](decoded)
			}
		}
	}
	return result
}

function normalizeQuery(options) {
	if (!options || typeof options.url !== 'string') return options
	const method = (options.method || 'GET').toUpperCase()
	if (!['GET', 'HEAD', 'DELETE'].includes(method)
		|| Object.prototype.toString.call(options.data) !== '[object Object]') return options

	// Normalize once before the bridge so every host receives the same URL and no body.
	// Arrays use repeated keys; nullish fields and array items are omitted.
	const pairs = []
	for (const [key, value] of Object.entries(options.data)) {
		for (const item of Array.isArray(value) ? value : [value]) {
			if (item !== null && item !== undefined) {
				pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(item))}`)
			}
		}
	}

	let url = options.url
	if (pairs.length) {
		const hashIndex = url.indexOf('#')
		const fragment = hashIndex < 0 ? '' : url.slice(hashIndex)
		const base = hashIndex < 0 ? url : url.slice(0, hashIndex)
		const separator = base.includes('?') ? (/[?&]$/.test(base) ? '' : '&') : '?'
		url = `${base}${separator}${pairs.join('&')}${fragment}`
	}
	const normalized = { ...options, url, method }
	delete normalized.data
	return normalized
}

/**
 * 发起 HTTPS 网络请求
 * https://developers.weixin.qq.com/miniprogram/dev/api/network/request/wx.request.html
 * @param {*} opts
 */
export function request(opts) {
	return invokeAPI('request', prepareBinaryRequest(debugRequest(normalizeQuery(opts))))
}
