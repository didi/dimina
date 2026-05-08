import serviceURL from '@dimina/service?url'
import mitt from 'mitt'

export class JSCore {
	constructor(parent) {
		this.parent = parent
		this.worker = null
		this.event = mitt()
	}

	async init() {
		// 使用 Web Worker 创建逻辑线程
		// 使用下面的形式会使 hash 失效
		// this.worker = new Worker(new URL('@dimina/service', import.meta.url))；
		const namespaces = this.parent.getApiNamespaces?.() || []
		const workerName = JSON.stringify({ apiNamespaces: namespaces })
		this.worker = new Worker(serviceURL, { type: 'classic', name: workerName })

		// 监听逻辑线程的消息
		this.worker.onmessage = (e) => {
			const msg = e.data
			this.event.emit(msg.method, msg)
		}
	}

	/**
	 * 在逻辑线程注册消息处理监听器 invoke
	 */
	invoke(handler) {
		this.event.on('invoke', handler)
	}

	/**
	 * 在逻辑线程注册消息中转监听器 publish
	 */
	publish(handler) {
		this.event.on('publish', handler)
	}

	/**
	 * 向逻辑线程发送消息
	 */
	postMessage(msg) {
		this.worker.postMessage(msg)
	}

	/**
	 * 释放 Web Worker
	 */
	destroy() {
		this.worker.terminate()
	}
}
