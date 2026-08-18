import { isAndroid, isIOS } from '@dimina/common'
import mitt from 'mitt'
import { decodeDataFunctions } from './data-function'

class Message {
	constructor() {
		this.event = mitt()
		this.init()
	}

	init() {
		if (!window.DiminaRenderBridge) {
			window.DiminaRenderBridge = {}
		}
		// window.DiminaRenderBridge 是容器提供，容器调用此方法给视图层发消息
		window.DiminaRenderBridge.onMessage = (msg) => {
			const decodedMsg = decodeDataFunctions(msg)
			console.log('[system]', '[render]', 'receive msg: ', decodedMsg)
			const { type, body } = decodedMsg
			this.event.emit(type, body)
		}
	}

	// 向渲染层注册消息监听
	on(type, callback) {
		this.event.on(type, callback)
	}

	// 渲染层经过容器层中转向逻辑层发送消息
	send(msg) {
		window.DiminaRenderBridge.publish(JSON.stringify(msg))
	}

	// 渲染层向容器层发送消息
	invoke(msg) {
		// android/ios 只能接收基础类型，需要转换成字符串
		if (isAndroid || isIOS) {
			Message.prototype.invoke = function (msg) {
				window.DiminaRenderBridge.invoke(JSON.stringify(msg))
			}
		}
		else {
			Message.prototype.invoke = function (msg) {
				window.DiminaRenderBridge.invoke(msg)
			}
		}
		return this.invoke(msg)
	}

	off(type, callback) {
		this.event.off(type, callback)
	}

	wait(eventName) {
		return new Promise((resolve) => {
			this.on(eventName, (msg) => {
				resolve(msg.data)
				this.off(eventName)
			})
		})
	}

	waitAndSend(eventName, msg) {
		const response = this.wait(eventName)
		this.send(msg)
		return response
	}
}

export default new Message()
