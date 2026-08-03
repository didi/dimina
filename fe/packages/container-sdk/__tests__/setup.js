import { afterEach, vi } from 'vitest'
import { installFakeWorker, resetFakeWorker } from './fixtures/fake-worker.js'

// jsdom 里没有 Worker，真实 SDK 的逻辑线程初始化（new Worker(...)）不 polyfill 的话
// 会同步抛 ReferenceError，进而在 openApp 的后台链路里变成 unhandled rejection。
installFakeWorker()

// 真实的渲染线程通过 iframe + window.frames[name].DiminaRenderBridge 协议通信
// （见 fe/packages/container/src/pages/webview/webview.js、src/core/bridge.js）。
// jsdom 默认不会为 iframe 触发资源加载，也不会有 DiminaRenderBridge，
// 这里给一个通用兜底：iframe 一旦挂载，就补上 DiminaRenderBridge 桩并派发 load 事件，
// 避免渲染层握手把测试挂死或抛错——这纯粹是测试基建，不代表实现协议。
function ensureRenderBridge(win) {
	try {
		if (win && !win.DiminaRenderBridge) {
			win.DiminaRenderBridge = {
				invoke: null,
				publish: null,
				onMessage: vi.fn(),
			}
		}
	}
	catch {
		// 访问 contentWindow 失败（跨域/已卸载等），忽略
	}
}

function handleIframe(iframe) {
	queueMicrotask(() => {
		ensureRenderBridge(iframe.contentWindow)
		iframe.dispatchEvent(new Event('load'))
	})
}

function scanForIframes(node) {
	if (!node || node.nodeType !== 1) {
		return
	}
	if (node.tagName === 'IFRAME') {
		handleIframe(node)
	}
	node.querySelectorAll?.('iframe').forEach(handleIframe)
}

let iframeObserver
if (typeof document !== 'undefined' && typeof MutationObserver !== 'undefined') {
	iframeObserver = new MutationObserver((mutations) => {
		for (const mutation of mutations) {
			mutation.addedNodes.forEach(scanForIframes)
		}
	})
	iframeObserver.observe(document.documentElement, { childList: true, subtree: true })
}

afterEach(() => {
	resetFakeWorker()
	vi.restoreAllMocks()
	// no-demo-imports.spec.js 用 `// @vitest-environment node` 跑纯 fs 扫描，没有 document。
	if (typeof document !== 'undefined') {
		document.body.innerHTML = ''
	}
})
