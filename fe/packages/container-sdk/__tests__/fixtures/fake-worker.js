import { vi } from 'vitest'

/**
 * jsdom 不实现 Worker。真实 SDK 会为逻辑线程 new 一个 Worker（同
 * fe/packages/container/src/core/jscore.js 的现状），这里给一个可观测的假 Worker，
 * 只记录构造参数和 postMessage 调用，不做任何真实的消息回环。
 */
export class FakeWorker {
	constructor(url, options) {
		this.url = url
		this.options = options
		this.onmessage = null
		this.onerror = null
		this.postMessage = vi.fn()
		this.terminate = vi.fn()
		this.addEventListener = vi.fn()
		this.removeEventListener = vi.fn()
		FakeWorker.instances.push(this)
	}
}

FakeWorker.instances = []

export function installFakeWorker() {
	globalThis.Worker = FakeWorker
}

export function resetFakeWorker() {
	FakeWorker.instances.length = 0
}
