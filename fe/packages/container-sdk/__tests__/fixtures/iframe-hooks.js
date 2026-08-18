import { afterEach } from 'vitest'

/**
 * 测试基建：拦截"下一个被挂到 DOM 上的、带 iframe 的 webview 根节点"，
 * 在它被 appendChild 进容器的*同一个同步调用栈*里对它的 iframe 做手脚
 * （必须早于 setup.js 里全局 MutationObserver 的 queueMicrotask 回调——
 * 那个回调负责补 DiminaRenderBridge 桩并派发 load 事件，一旦晚了就来不及
 * 拦截）。
 *
 * 用法：
 *   const hook = interceptNextWebviewIframe((iframe) => {
 *     // 在这里同步操作 iframe / iframe.contentWindow
 *   })
 *   // ... 触发会创建新 webview 的动作 ...
 *   hook.restore()
 *
 * 兜底：如果调用方在 restore() 之前抛错/断言失败，模块级 afterEach 会强制
 * 还原 Element.prototype.appendChild，避免这个猴子补丁泄漏到下一个测试文件。
 */
let activeRestore = null

afterEach(() => {
	activeRestore?.()
	activeRestore = null
})

export function interceptNextWebviewIframe(onIntercept) {
	const originalAppendChild = Element.prototype.appendChild
	let armed = true
	let node = null
	let iframe = null

	Element.prototype.appendChild = function (child) {
		// eslint-disable-next-line prefer-rest-params
		const result = originalAppendChild.apply(this, arguments)
		if (armed && child && typeof child.querySelector === 'function') {
			const found = child.querySelector('iframe')
			if (found) {
				armed = false
				node = child
				iframe = found
				onIntercept(iframe, node)
			}
		}
		return result
	}

	const restore = () => {
		Element.prototype.appendChild = originalAppendChild
		if (activeRestore === restore) {
			activeRestore = null
		}
	}
	activeRestore = restore

	return {
		restore,
		getNode() {
			return node
		},
		getIframe() {
			return iframe
		},
	}
}
