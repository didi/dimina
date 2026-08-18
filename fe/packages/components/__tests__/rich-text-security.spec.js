/** @vitest-environment jsdom */

import { renderRichTextNodes, sanitizeRichText } from '../src/component/rich-text/richTextSanitizer.js'

describe('rich-text sanitization', () => {
	it('removes executable tags, attributes, and URL schemes', () => {
		const sanitized = sanitizeRichText(`
			<script>alert(1)</script>
			<img src="x" onerror="alert(1)">
			<svg onload="alert(1)"><circle /></svg>
			<a href="javascript:alert(1)">link</a>
		`)

		expect(sanitized).not.toMatch(/script|onerror|onload|javascript:|<svg/i)
		expect(sanitized).toContain('<img src="x">')
		expect(sanitized).toContain('<a>link</a>')
	})

	it('builds array nodes without treating text or attributes as markup', () => {
		const html = renderRichTextNodes([{
			name: 'span',
			attrs: {
				title: `\"><img src=x onerror=alert(1)>`,
				onclick: 'alert(1)',
			},
			children: [{ type: 'text', text: '</span><script>alert(1)</script>' }],
		}], 'nbsp')
		const sanitized = sanitizeRichText(html)
		const container = document.createElement('div')
		container.innerHTML = sanitized

		expect(container.querySelector('script, img')).toBeNull()
		expect(container.querySelector('span')?.hasAttribute('onclick')).toBe(false)
		expect(sanitized).toContain('&lt;/span&gt;&lt;script&gt;alert(1)&lt;/script&gt;')
	})
})
