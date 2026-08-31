/**
 * wx.onWindowResize 注册表：listener 函数 → evtId。
 *
 * 表放在这里而不是 API 模块里，是为了让 runtime 能在派发尺寸变化时读到它，又不必反向 import API 层（会与 api/common 形成循环）。
 * 注册与注销仍然只由 api/core/ui/window 写入，这里不含任何业务判断。
 *
 * callback 模块全局的 keep=true 去重只认函数身份，off 一个从未 on 过的函数会被当成"没找到就新建"，留下一条永远不会被触发、也没人清理的 callback；这张表让 off 直接定位到 on 时生成的 evtId，不经过那条全局去重路径。
 * 它同时承担本 API 的重复注册去重：同一函数重复 on 复用已有 evtId（微信语义）。
 */
const listenerIds = new Map()

export function getWindowResizeListenerId(listener) {
	return listenerIds.get(listener)
}

export function setWindowResizeListenerId(listener, evtId) {
	listenerIds.set(listener, evtId)
}

export function deleteWindowResizeListenerId(listener) {
	listenerIds.delete(listener)
}

/** 注册顺序即触发顺序：按注册次序遍历监听数组。 */
export function windowResizeListenerIds() {
	return Array.from(listenerIds.values())
}

export function takeAllWindowResizeListenerIds() {
	const evtIds = Array.from(listenerIds.values())
	listenerIds.clear()
	return evtIds
}
