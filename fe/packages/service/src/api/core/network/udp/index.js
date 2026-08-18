import {
	createNativeEvent,
	createSocketId,
	decodeSocketMessageResult,
	encodeSocketMessage,
	invokeSocketMethod,
} from '../socket/shared'

class UDPSocket {
	constructor(socketId) {
		this.socketId = socketId
		this.events = {
			close: createNativeEvent('UDPSocket.onClose', 'UDPSocket.offClose', { socketId }),
			error: createNativeEvent('UDPSocket.onError', 'UDPSocket.offError', { socketId }),
			listening: createNativeEvent('UDPSocket.onListening', 'UDPSocket.offListening', { socketId }),
			message: createNativeEvent('UDPSocket.onMessage', 'UDPSocket.offMessage', { socketId }, decodeSocketMessageResult),
		}
		this.events.close.setAfterEmit(() => {
			for (const event of Object.values(this.events)) event.dispose()
		})
	}

	bind(port = 0) {
		return invokeSocketMethod('UDPSocket.bind', this.socketId, { port })
	}

	close() {
		const result = invokeSocketMethod('UDPSocket.close', this.socketId)
		for (const [name, event] of Object.entries(this.events)) {
			if (name !== 'close' || !event.hasListeners()) event.dispose()
		}
		return result
	}

	connect(options = {}) {
		return invokeSocketMethod('UDPSocket.connect', this.socketId, options)
	}

	send(options = {}) {
		return this.sendWithName('UDPSocket.send', options)
	}

	write(options = {}) {
		return this.sendWithName('UDPSocket.write', options)
	}

	setTTL(ttl) {
		return invokeSocketMethod('UDPSocket.setTTL', this.socketId, { ttl })
	}

	onClose(listener) { return this.events.close.on(listener) }
	offClose(listener) { return this.events.close.off(listener) }
	onError(listener) { return this.events.error.on(listener) }
	offError(listener) { return this.events.error.off(listener) }
	onListening(listener) { return this.events.listening.on(listener) }
	offListening(listener) { return this.events.listening.off(listener) }
	onMessage(listener) { return this.events.message.on(listener) }
	offMessage(listener) { return this.events.message.off(listener) }

	sendWithName(name, options) {
		return invokeSocketMethod(name, this.socketId, {
			...options,
			message: encodeSocketMessage(options.message),
		})
	}
}

export function createUDPSocket() {
	return new UDPSocket(createSocketId('udp'))
}
