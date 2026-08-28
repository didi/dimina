import type { JSCore } from '../src/core/jscore.js'
import type { WebView } from '../src/pages/webview/webview.js'
import { describe, expect, it, vi } from 'vitest'
import { Bridge } from '../src/core/bridge.js'

describe('Bridge shared JSCore listener lifecycle', () => {
	it('unsubscribes both shared service listeners when the bridge is destroyed', async () => {
		const unsubscribeInvoke = vi.fn()
		const unsubscribePublish = vi.fn()
		const jscore = {
			invoke: vi.fn(() => unsubscribeInvoke),
			publish: vi.fn(() => unsubscribePublish),
			postMessage: vi.fn(),
		} as unknown as JSCore
		const bridge = new Bridge({ jscore } as ConstructorParameters<typeof Bridge>[0])
		const webview = {
			invoke: vi.fn(),
			publish: vi.fn(),
		} as unknown as WebView
		;(bridge as unknown as { createWebview: () => Promise<WebView> }).createWebview
			= vi.fn(async () => webview)

		await bridge.init()
		bridge.destroy()
		bridge.destroy()

		expect(jscore.invoke).toHaveBeenCalledTimes(1)
		expect(jscore.publish).toHaveBeenCalledTimes(1)
		expect(unsubscribeInvoke).toHaveBeenCalledTimes(1)
		expect(unsubscribePublish).toHaveBeenCalledTimes(1)
	})
})
