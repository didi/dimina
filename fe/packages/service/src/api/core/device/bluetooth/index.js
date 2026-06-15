import { invokeAPI } from '@/api/common'

/**
 * 停止搜寻附近的蓝牙外围设备。若已经找到需要的蓝牙设备并不需要继续搜索时，建议调用该接口停止蓝牙搜索。
 * https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth/wx.stopBluetoothDevicesDiscovery.html
 */
export function stopBluetoothDevicesDiscovery(opts) {
	return invokeAPI('stopBluetoothDevicesDiscovery', opts)
}

/**
 * 开始搜寻附近的蓝牙外围设备
 * https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth/wx.startBluetoothDevicesDiscovery.html
 */
export function startBluetoothDevicesDiscovery(opts) {
	return invokeAPI('startBluetoothDevicesDiscovery', opts)
}

/**
 * 初始化蓝牙模块。iOS 上开启主机/从机（外围设备）模式时需分别调用一次，并指定对应的 mode。
 * https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth/wx.openBluetoothAdapter.html
 */
export function openBluetoothAdapter(opts) {
	return invokeAPI('openBluetoothAdapter', opts)
}

/**
 * 监听搜索到新设备的事件
 * https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth/wx.onBluetoothDeviceFound.html
 */
export function onBluetoothDeviceFound(opts) {
	return invokeAPI('onBluetoothDeviceFound', opts)
}

/**
 * 监听蓝牙适配器状态变化事件
 * https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth/wx.onBluetoothAdapterStateChange.html
 */
export function onBluetoothAdapterStateChange(opts) {
	return invokeAPI('onBluetoothAdapterStateChange', opts)
}

/**
 * 移除搜索到新设备的事件的全部监听函数
 * https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth/wx.offBluetoothDeviceFound.html
 */
export function offBluetoothDeviceFound() {
	return invokeAPI('offBluetoothDeviceFound')
}

/**
 * 移除蓝牙适配器状态变化事件的全部监听函数
 * https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth/wx.offBluetoothAdapterStateChange.html
 */
export function offBluetoothAdapterStateChange() {
	return invokeAPI('offBluetoothAdapterStateChange')
}

/**
 * 根据主服务 UUID 获取已连接的蓝牙设备
 * https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth/wx.getConnectedBluetoothDevices.html
 */
export function getConnectedBluetoothDevices(opts) {
	return invokeAPI('getConnectedBluetoothDevices', opts)
}

/**
 * 获取在蓝牙模块生效期间所有搜索到的蓝牙设备。包括已经和本机处于连接状态的设备
 * https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth/wx.getBluetoothDevices.html
 */
export function getBluetoothDevices(opts) {
	return invokeAPI('getBluetoothDevices', opts)
}

/**
 * 获取本机蓝牙适配器状态
 * https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth/wx.getBluetoothAdapterState.html
 */
export function getBluetoothAdapterState(opts) {
	return invokeAPI('getBluetoothAdapterState', opts)
}

/**
 * 关闭蓝牙模块。调用该方法将断开所有已建立的连接并释放系统资源。建议在使用蓝牙流程后，与 wx.openBluetoothAdapter 成对调用。
 * https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth/wx.closeBluetoothAdapter.html
 */
export function closeBluetoothAdapter(opts) {
	return invokeAPI('closeBluetoothAdapter', opts)
}
