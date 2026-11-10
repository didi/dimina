import Prism from 'prismjs'
import 'prismjs/components/prism-json.js'

Prism.manual = true
const interpolation = { pattern: /\{\{[\s\S]*?\}\}/, inside: Prism.languages.javascript }
Prism.languages.wxml = Prism.languages.extend('markup', { interpolation })
Prism.languages.wxml.tag.inside['attr-value'].inside.interpolation = interpolation

export function sourceLanguage(path = '') {
	return ({ js: 'javascript', json: 'json', wxml: 'wxml', wxss: 'css' })[path?.split('.').pop()] || 'plain'
}

export function highlightSource(text, path) {
	const language = sourceLanguage(path)
	return Prism.highlight(text, Prism.languages[language], language)
}

/** Keep the native textarea responsible for input, selection, IME and undo. */
export function createSourceHighlight({ input, layer }) {
	const code = layer.querySelector('code')
	const wrapper = input.parentElement
	let path, pending, destroyed = false
	const syncScroll = () => { layer.scrollTop = input.scrollTop; layer.scrollLeft = input.scrollLeft }
	const measure = () => {
		if (!input.clientWidth || !input.clientHeight) return
		const style = getComputedStyle(input)
		layer.style.inlineSize = `${input.clientWidth + Number.parseFloat(style.borderLeftWidth) + Number.parseFloat(style.borderRightWidth)}px`
		layer.style.blockSize = `${input.clientHeight + Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.borderBottomWidth)}px`
		syncScroll()
	}
	const refresh = () => {
		if (destroyed) return
		if (pending !== undefined) cancelAnimationFrame(pending)
		pending = undefined
		// A final blank line needs a space to have the same height as a textarea.
		code.innerHTML = highlightSource(input.value, path) + (input.value.endsWith('\n') ? ' ' : '')
		wrapper.dataset.language = sourceLanguage(path)
		measure()
		syncScroll()
	}
	const schedule = () => {
		if (pending === undefined) pending = requestAnimationFrame(() => { pending = undefined; refresh() })
	}
	const composing = () => wrapper.classList.add('is-composing')
	const composed = () => { wrapper.classList.remove('is-composing'); refresh() }
	input.addEventListener('input', schedule)
	input.addEventListener('scroll', syncScroll, { passive: true })
	input.addEventListener('compositionstart', composing)
	input.addEventListener('compositionend', composed)
	const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
	observer?.observe(input)
	window.addEventListener('resize', measure)
	refresh()
	return {
		setFile(nextPath) {
			if (path !== nextPath) { input.scrollTop = 0; input.scrollLeft = 0 }
			path = nextPath
			refresh()
		},
		refresh,
		destroy() {
			destroyed = true
			if (pending !== undefined) cancelAnimationFrame(pending)
			observer?.disconnect()
			window.removeEventListener('resize', measure)
			input.removeEventListener('input', schedule)
			input.removeEventListener('scroll', syncScroll)
			input.removeEventListener('compositionstart', composing)
			input.removeEventListener('compositionend', composed)
		},
	}
}
