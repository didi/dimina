/* eslint-disable no-undef */
import { isWebWorker } from '@dimina/common'
import mitt from 'mitt'

class Message {
	constructor() {
		this.event = mitt()
		this.init()
	}

	init() {
		// 逻辑层监听容器层消息
		if (isWebWorker) {
			globalThis.onmessage = (e) => {
				this.handleMsg(e.data)
			}
		}
		else {
			DiminaServiceBridge.onMessage = this.handleMsg.bind(this)
		}
	}

	handleMsg(msg) {
		console.log('[service] receive msg: ', isWebWorker ? msg : JSON.stringify(msg))
		const { type, body } = msg
		this.event.emit(type, body)
	}

	// 向逻辑层注册消息监听
	on(type, callback) {
		this.event.on(type, callback)
	}

	off(type) {
		this.event.off(type)
	}

	// 逻辑层透过容器层中转向渲染层发送消息
	send(msg) {
		if (isWebWorker) {
			Message.prototype.send = function (msg) {
				msg.method = 'publish'
				globalThis.postMessage(msg)
			}
		}
		else {
			Message.prototype.send = function (msg) {
				return DiminaServiceBridge.publish(msg.body.bridgeId || '', msg)
			}
		}
		return this.send(msg)
	}

	// 逻辑层向容器层发送消息
	invoke(msg) {
		if (isWebWorker) {
			Message.prototype.invoke = function (msg) {
				msg.method = 'invoke'
				globalThis.postMessage(msg)
			}
		}
		else {
			Message.prototype.invoke = function (msg) {
				return DiminaServiceBridge.invoke(msg)
			}
		}

		return this.invoke(msg)
	}
}

export default new Message()
