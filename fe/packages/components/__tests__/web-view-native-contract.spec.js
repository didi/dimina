import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const WEB_VIEW_FILE = fileURLToPath(new URL('../src/component/web-view/WebView.vue', import.meta.url))

describe('web-view native component contract', () => {
	it('reports its bounds and exposes an Android touch target', () => {
		const source = fs.readFileSync(WEB_VIEW_FILE, 'utf8')

		expect(source).toContain('rect: getRect()')
		expect(source).toContain('ensureNativeLayerTouchBridge()')
		expect(source).toContain(':data-dimina-native-id="id"')
		expect(source).toContain(':data-dimina-native-type="type"')
	})

	it('keeps the native component synchronized and releases it on unmount', () => {
		const source = fs.readFileSync(WEB_VIEW_FILE, 'utf8')

		expect(source).toContain("window.addEventListener('scroll', scheduleSyncRect, true)")
		expect(source).toContain("invokeNative('componentMount')")
		expect(source).toContain("invokeNative('componentUnmount')")
	})
})
