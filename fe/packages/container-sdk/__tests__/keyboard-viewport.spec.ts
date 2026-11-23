import { afterEach, expect, it, vi } from 'vitest'
import type { Bridge } from '../src/core/bridge.js'
import { MiniApp } from '../src/pages/miniApp/miniApp.js'

afterEach(() => vi.unstubAllGlobals())

it('reports host keyboard occlusion to the active mini program and detaches when hidden', () => {
	const app = new MiniApp({ appId: 'keyboard', pagePath: 'index' })
	const iframe = document.createElement('iframe')
	const hostInput = document.createElement('input')
	document.body.append(iframe, hostInput)
	const page = iframe.contentDocument!
	const input = page.body.appendChild(page.createElement('input'))
	const textarea = page.body.appendChild(page.createElement('textarea'))
	vi.spyOn(app.navigator, 'top', 'get').mockReturnValue({
		webview: { iframe },
		pageShow: vi.fn(),
		pageHide: vi.fn(),
	} as unknown as Bridge)
	const viewport = Object.assign(new EventTarget(), { height: 800, offsetTop: 0, scale: 1 })
	vi.stubGlobal('visualViewport', viewport)
	vi.stubGlobal('innerHeight', 800)
	const post = vi.spyOn(app.jscore, 'postMessage')
	const heights = () => post.mock.calls.map(([msg]) => msg)
		.filter(msg => msg.type === 'keyboardHeightChange').map(msg => msg.body)
	const resize = (height: number) => {
		viewport.height = height
		viewport.dispatchEvent(new Event('resize'))
	}

	try {
		app.onPresentIn()
		hostInput.focus()
		resize(500)
		expect(heights()).toEqual([])

		input.focus()
		resize(500)
		textarea.focus()
		resize(500)
		resize(550)
		resize(800)
		expect(heights()).toEqual([{ height: 300 }, { height: 250 }, { height: 0 }])

		viewport.scale = 2
		resize(400)
		expect(heights()).toHaveLength(3)
		viewport.scale = 1
		resize(500)
		const removeListener = vi.spyOn(viewport, 'removeEventListener')
		app.onPresentOut()
		resize(400)
		expect(removeListener.mock.calls.map(([event]) => event)).toEqual(['resize', 'scroll'])
		expect(heights().slice(3)).toEqual([{ height: 300 }, { height: 0 }])
	}
	finally {
		iframe.remove()
		hostInput.remove()
	}
})
