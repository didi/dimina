import { vi } from 'vitest'
import { createAppConfigResponse } from './app-config.js'

function toUrlString(input) {
	if (typeof input === 'string') {
		return input
	}
	if (input instanceof URL) {
		return input.toString()
	}
	return input?.url ?? String(input)
}

function jsonResponse(payload) {
	const text = JSON.stringify(payload)
	return Promise.resolve({
		ok: true,
		status: 200,
		json: () => Promise.resolve(JSON.parse(text)),
		text: () => Promise.resolve(text),
	})
}

/**
 * 装一个通用 fetch mock：
 * - 命中 appList.json 的请求返回空列表（并被记录，供"未提供 getAppInfo 时不应请求"的用例断言）
 * - 其余请求（配置/页面等资源）一律返回最小可用的 app-config.json
 * 所有请求的 URL 都会被记录到返回的 calls 数组，用于断言请求前缀（resourceBaseUrl 贯通）。
 */
export function installFetchMock() {
	const calls = []

	const fetchMock = vi.fn((input) => {
		const url = toUrlString(input)
		calls.push(url)

		if (url.includes('appList.json')) {
			return jsonResponse([])
		}

		return jsonResponse(createAppConfigResponse())
	})

	globalThis.fetch = fetchMock

	return { fetchMock, calls }
}
