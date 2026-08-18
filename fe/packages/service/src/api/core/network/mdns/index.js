import { invokeAPI } from '@/api/common'
import { createNativeEvent } from '../socket/shared'

const discoveryStopEvent = createNativeEvent('onLocalServiceDiscoveryStop', 'offLocalServiceDiscoveryStop')
const foundEvent = createNativeEvent('onLocalServiceFound', 'offLocalServiceFound')
const lostEvent = createNativeEvent('onLocalServiceLost', 'offLocalServiceLost')
const resolveFailEvent = createNativeEvent('onLocalServiceResolveFail', 'offLocalServiceResolveFail')

export function startLocalServiceDiscovery(options = {}) {
	return invokeAPI('startLocalServiceDiscovery', options)
}

export function stopLocalServiceDiscovery(options = {}) {
	return invokeAPI('stopLocalServiceDiscovery', options)
}

export function onLocalServiceDiscoveryStop(listener) { return discoveryStopEvent.on(listener) }
export function offLocalServiceDiscoveryStop(listener) { return discoveryStopEvent.off(listener) }
export function onLocalServiceFound(listener) { return foundEvent.on(listener) }
export function offLocalServiceFound(listener) { return foundEvent.off(listener) }
export function onLocalServiceLost(listener) { return lostEvent.on(listener) }
export function offLocalServiceLost(listener) { return lostEvent.off(listener) }
export function onLocalServiceResolveFail(listener) { return resolveFailEvent.on(listener) }
export function offLocalServiceResolveFail(listener) { return resolveFailEvent.off(listener) }
