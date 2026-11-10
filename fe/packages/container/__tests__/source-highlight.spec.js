// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createSourceHighlight, highlightSource, sourceLanguage } from '../src/sourceHighlight.js'

afterEach(() => document.body.replaceChildren())

describe('source syntax highlighting', () => {
	it.each([
		['pages/index.js', 'const title = "你好"; // 备注', 'javascript', '.token.keyword'],
		['app.json', '{"pages":["pages/index"],"enabled":true}', 'json', '.token.property'],
		['pages/index.wxml', '<view wx:if="{{count > 0}}">{{title}}</view>', 'wxml', '.token.tag'],
		['pages/index.wxss', '.page { color: red; padding: 20rpx; }', 'css', '.token.selector'],
	])('highlights %s as source text', (path, source, language, selector) => {
		const element = document.createElement('code')
		element.innerHTML = highlightSource(source, path)
		expect(sourceLanguage(path)).toBe(language)
		expect(element.querySelector(selector)).not.toBeNull()
		expect(element.textContent).toBe(source)
	})
	it('keeps model markup inert, including script tags and event attributes', () => {
		const source = '<script>window.evil = true</script><img src=x onerror="window.evil=true">'
		const element = document.createElement('code')
		element.innerHTML = highlightSource(source, 'pages/index.wxml')
		expect(element.querySelector('script, img')).toBeNull()
		expect(element.textContent).toBe(source)
	})
	it('highlights WXML expressions inside attributes and text', () => {
		const element = document.createElement('code')
		element.innerHTML = highlightSource('<view wx:if="{{count > 0}}">{{title}}</view>', 'index.wxml')
		expect(element.querySelectorAll('.token.interpolation')).toHaveLength(2)
	})
	it('refreshes highlighting without replacing user text or selection', () => {
		document.body.innerHTML = '<div><pre aria-hidden="true"><code></code></pre><textarea></textarea></div>'
		const input = document.querySelector('textarea'), layer = document.querySelector('pre')
		input.value = 'const 标题 = "待办";\n'
		input.setSelectionRange(6, 8)
		const editor = createSourceHighlight({ input, layer })
		editor.setFile('index.js')
		expect(input.value).toBe('const 标题 = "待办";\n')
		expect([input.selectionStart, input.selectionEnd]).toEqual([6, 8])
		expect(layer.querySelector('.token.keyword')).not.toBeNull()
		expect(layer.textContent).toBe(`${input.value} `)
		input.dispatchEvent(new CompositionEvent('compositionstart'))
		expect(input.parentElement.classList.contains('is-composing')).toBe(true)
		input.dispatchEvent(new CompositionEvent('compositionend'))
		expect(input.parentElement.classList.contains('is-composing')).toBe(false)
		editor.destroy()
	})
})
