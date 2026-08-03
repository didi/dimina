import { callback, isFunction } from '@dimina/common'
import { invokeAPI } from '@/api/common'

/**
 * 获取当前的地理位置、速度。
 * https://developers.weixin.qq.com/miniprogram/dev/api/location/wx.getLocation.html
 */
export function getLocation(opts) {
	return invokeAPI('getLocation', opts)
}

/**
 * 开启小程序进入前台时接收位置消息。
 * https://developers.weixin.qq.com/miniprogram/dev/api/location/wx.startLocationUpdate.html
 */
export function startLocationUpdate(opts) {
	return invokeAPI('startLocationUpdate', opts)
}

/**
 * 使用内置地图查看位置
 * https://developers.weixin.qq.com/miniprogram/dev/api/location/wx.openLocation.html
 */
export function openLocation(opts) {
	return invokeAPI('openLocation', opts)
}

/**
 * 关闭监听实时位置变化，前后台都停止消息接收
 * https://developers.weixin.qq.com/miniprogram/dev/api/location/wx.stopLocationUpdate.html
 */
export function stopLocationUpdate(opts) {
	return invokeAPI('stopLocationUpdate', opts)
}

// 位置监听登记在所有接口共用的那张回调表里，表按函数身份给常驻回调去重——同一个
// 函数如果也被别的接口登记成常驻监听，两边会共用同一个 id，光靠记住 id 还是会在
// 移除时连累对方。所以这里给每个 listener 包一层，让它在回调表里有属于定位自己的
// 身份，再用这张表记住 listener 和包装后的 id 的对应关系。
const locationListenerIds = new Map()

/**
 * 监听实时地理位置变化事件
 * https://developers.weixin.qq.com/miniprogram/dev/api/location/wx.onLocationChange.html
 */
export function onLocationChange(listener) {
	// 必须挡住非函数。包装函数是照着 listener 调的，放进来的话回调表里会留下一条
	// 常驻记录，原生每推一次就抛一次 TypeError。
	if (!isFunction(listener) || locationListenerIds.has(listener)) {
		return
	}
	const id = callback.store(value => listener(value), true)
	locationListenerIds.set(listener, id)
	try {
		invokeAPI('onLocationChange', {
			success: id,
		})
	}
	catch (error) {
		// 桥调用没成功就当作没登记过，否则这个 listener 会卡在「表里有、原生没有」
		// 的状态，之后再调 onLocationChange 会因为已登记而直接返回，永远没法重试。
		locationListenerIds.delete(listener)
		callback.remove(id)
		throw error
	}
}

/**
 * 移除实时地理位置变化事件的监听函数
 * https://developers.weixin.qq.com/miniprogram/dev/api/location/wx.offLocationChange.html
 * @param {*} listener onLocationChange 传入的监听函数。不传此参数则移除所有监听函数。
 */
export function offLocationChange(listener) {
	// 只有「不传参数」才是移除全部。传了值就得是函数，否则按无效入参忽略——
	// false / 0 / '' / null 这些都不能被当成没传，那会误摘掉全部监听。
	// 注意 offLocationChange(null) 因此从「移除全部」变成了忽略。
	if (listener !== undefined) {
		// 不是函数，或者这个函数没登记过，都没有对应的回调 id 可摘。
		const id = isFunction(listener) ? locationListenerIds.get(listener) : undefined
		if (!id) {
			return
		}
		// 先下发再清理。抛错时状态原样保留，调用方重试还能摘掉；反过来写的话
		// 这条监听就变成表里没有、原生还留着的幽灵。
		invokeAPI('offLocationChange', {
			success: id,
		})
		locationListenerIds.delete(listener)
		callback.remove(id)
	}
	else {
		invokeAPI('offLocationChange')
		for (const id of locationListenerIds.values()) {
			callback.remove(id)
		}
		locationListenerIds.clear()
	}
}
