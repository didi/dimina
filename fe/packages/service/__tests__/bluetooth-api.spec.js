import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/api/common', () => ({
	invokeAPI: vi.fn(),
}))

import { callback } from '@dimina/common'
import { invokeAPI } from '@/api/common'
import {
	getBluetoothDevices,
	offBluetoothDeviceFound,
	onBluetoothDeviceFound,
} from '../src/api/core/device/bluetooth/index.js'
import {
	offBLECharacteristicValueChange,
	onBLECharacteristicValueChange,
	writeBLECharacteristicValue,
} from '../src/api/core/device/bluetooth-ble/index.js'

function bytes(buffer) {
	return Array.from(new Uint8Array(buffer))
}

describe('bluetooth api service adapter', () => {
	beforeEach(() => {
		vi.mocked(invokeAPI).mockReset()
		callback.remove()
	})

	it('encodes characteristic ArrayBuffer values before forwarding writes', () => {
		const value = new Uint8Array([1, 2, 3]).buffer
		const success = vi.fn()

		writeBLECharacteristicValue({
			deviceId: 'device',
			serviceId: 'service',
			characteristicId: 'characteristic',
			value,
			success,
		})

		expect(invokeAPI).toHaveBeenCalledWith('writeBLECharacteristicValue', expect.objectContaining({
			deviceId: 'device',
			value: { __diminaArrayBufferBase64: 'AQID' },
		}))
	})

	it('decodes discovered device advertisement and service data', async () => {
		vi.mocked(invokeAPI).mockResolvedValueOnce({
			devices: [{
				deviceId: 'device',
				advertisData: { __diminaArrayBufferBase64: 'AQI=' },
				serviceData: {
					FFF0: { __diminaArrayBufferBase64: 'AwQ=' },
				},
			}],
		})

		const result = await getBluetoothDevices()

		expect(bytes(result.devices[0].advertisData)).toEqual([1, 2])
		expect(bytes(result.devices[0].serviceData.FFF0)).toEqual([3, 4])
	})

	it('keeps characteristic listeners alive and decodes event values', () => {
		const listener = vi.fn()
		onBLECharacteristicValueChange(listener)
		const params = vi.mocked(invokeAPI).mock.calls[0][1]

		callback.invoke(params.callbackId, {
			deviceId: 'device',
			value: { __diminaArrayBufferBase64: 'BQY=' },
		})
		callback.invoke(params.callbackId, {
			deviceId: 'device',
			value: { __diminaArrayBufferBase64: 'Bw==' },
		})

		expect(listener).toHaveBeenCalledTimes(2)
		expect(bytes(listener.mock.calls[0][0].value)).toEqual([5, 6])
		expect(bytes(listener.mock.calls[1][0].value)).toEqual([7])
	})

	it('removes only the requested listener from native and service state', () => {
		const first = vi.fn()
		const second = vi.fn()
		onBluetoothDeviceFound(first)
		onBluetoothDeviceFound(second)
		const firstCallbackId = vi.mocked(invokeAPI).mock.calls[0][1].callbackId
		const secondCallbackId = vi.mocked(invokeAPI).mock.calls[1][1].callbackId

		offBluetoothDeviceFound(first)

		expect(invokeAPI).toHaveBeenLastCalledWith('offBluetoothDeviceFound', {
			callbackId: firstCallbackId,
			keep: true,
		})
		callback.invoke(firstCallbackId, { devices: [] })
		callback.invoke(secondCallbackId, { devices: [] })
		expect(first).not.toHaveBeenCalled()
		expect(second).toHaveBeenCalledTimes(1)
	})

	it('removes every characteristic listener when no function is supplied', () => {
		const first = vi.fn()
		const second = vi.fn()
		onBLECharacteristicValueChange(first)
		onBLECharacteristicValueChange(second)
		const firstCallbackId = vi.mocked(invokeAPI).mock.calls[0][1].callbackId
		const secondCallbackId = vi.mocked(invokeAPI).mock.calls[1][1].callbackId

		offBLECharacteristicValueChange()

		expect(invokeAPI).toHaveBeenLastCalledWith('offBLECharacteristicValueChange')
		callback.invoke(firstCallbackId, { value: { __diminaArrayBufferBase64: '' } })
		callback.invoke(secondCallbackId, { value: { __diminaArrayBufferBase64: '' } })
		expect(first).not.toHaveBeenCalled()
		expect(second).not.toHaveBeenCalled()
	})
})
