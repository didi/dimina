import {
	createNativeEvent,
	createSocketId,
	decodeSocketMessageResult,
	encodeSocketMessage,
	invokeSocketMethod,
} from '../socket/shared'

class TCPSocket {
	constructor(socketId) {
		this.socketId = socketId
		this.events = {
			bindWifi: createNativeEvent('TCPSocket.onBindWifi', 'TCPSocket.offBindWifi', { socketId }),
			close: createNativeEvent('TCPSocket.onClose', 'TCPSocket.offClose', { socketId }),
			connect: createNativeEvent('TCPSocket.onConnect', 'TCPSocket.offConnect', { socketId }),
			error: createNativeEvent('TCPSocket.onError', 'TCPSocket.offError', { socketId }),
			message: createNativeEvent('TCPSocket.onMessage', 'TCPSocket.offMessage', { socketId }, decodeSocketMessageResult),
		}
		this.events.close.setAfterEmit(() => {
			for (const event of Object.values(this.events)) event.dispose()
		})
	}

	bindWifi(options = {}) {
		return invokeSocketMethod('TCPSocket.bindWifi', this.socketId, options)
	}

	close() {
		const result = invokeSocketMethod('TCPSocket.close', this.socketId)
		for (const [name, event] of Object.entries(this.events)) {
			if (name !== 'close' || !event.hasListeners()) event.dispose()
		}
		return result
	}

	connect(options = {}) {
		return invokeSocketMethod('TCPSocket.connect', this.socketId, options)
	}

	write(data) {
		return invokeSocketMethod('TCPSocket.write', this.socketId, { data: encodeSocketMessage(data) })
	}

	onBindWifi(listener) { return this.events.bindWifi.on(listener) }
	offBindWifi(listener) { return this.events.bindWifi.off(listener) }
	onClose(listener) { return this.events.close.on(listener) }
	offClose(listener) { return this.events.close.off(listener) }
	onConnect(listener) { return this.events.connect.on(listener) }
	offConnect(listener) { return this.events.connect.off(listener) }
	onError(listener) { return this.events.error.on(listener) }
	offError(listener) { return this.events.error.off(listener) }
	onMessage(listener) { return this.events.message.on(listener) }
	offMessage(listener) { return this.events.message.off(listener) }
}

export function createTCPSocket() {
	return new TCPSocket(createSocketId('tcp'))
}
