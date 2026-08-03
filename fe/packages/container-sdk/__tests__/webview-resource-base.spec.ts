import { describe, expect, it, vi } from 'vitest'
import { WebView } from '../src/pages/webview/webview.js'

describe('WebView remote resource base', () => {
	it('points relative compiled assets at the per-app resource base via <base href>', () => {
		const webview = Object.create(WebView.prototype) as WebView
		webview.opts = { resourceBaseUrl: 'https://cdn.example.com/apps/' } as WebView['opts']
		const prepend = vi.fn()
		const frameDocument = {
			createElement: vi.fn(() => ({ href: '' })),
			head: { prepend },
		} as unknown as Document

		webview.applyResourceBaseUrl(frameDocument)

		expect(frameDocument.createElement).toHaveBeenCalledWith('base')
		expect(prepend).toHaveBeenCalledWith({ href: 'https://cdn.example.com/apps/' })
	})

	it('does not touch the document when no per-app resourceBaseUrl override is set', () => {
		const webview = Object.create(WebView.prototype) as WebView
		webview.opts = {} as WebView['opts']
		const frameDocument = {
			createElement: vi.fn(),
			head: { prepend: vi.fn() },
		} as unknown as Document

		webview.applyResourceBaseUrl(frameDocument)

		expect(frameDocument.createElement).not.toHaveBeenCalled()
		expect(frameDocument.head!.prepend).not.toHaveBeenCalled()
	})

	it('no-ops instead of throwing when the iframe document has no <head> (defensive, real browsers always have one)', () => {
		const webview = Object.create(WebView.prototype) as WebView
		webview.opts = { resourceBaseUrl: 'https://cdn.example.com/apps/' } as WebView['opts']
		const frameDocument = {
			createElement: vi.fn(() => ({ href: '' })),
			head: null,
		} as unknown as Document

		expect(() => webview.applyResourceBaseUrl(frameDocument)).not.toThrow()
	})
})
