import DOMPurify from 'dompurify'

// Keep this list aligned with the tags supported by the WeChat rich-text
// component. Executable/embedded content such as script, iframe, SVG and
// MathML is intentionally excluded.
export const RICH_TEXT_TAGS = [
	'a', 'abbr', 'address', 'article', 'aside', 'b', 'bdi', 'bdo', 'big',
	'blockquote', 'br', 'caption', 'center', 'cite', 'code', 'col', 'colgroup',
	'dd', 'del', 'div', 'dl', 'dt', 'em', 'fieldset', 'font', 'footer',
	'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'i', 'img', 'ins',
	'label', 'legend', 'li', 'mark', 'nav', 'ol', 'p', 'pre', 'q', 'rt',
	'ruby', 's', 'section', 'small', 'span', 'strong', 'sub', 'sup', 'table',
	'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'tt', 'u', 'ul',
]

const richTextTagSet = new Set(RICH_TEXT_TAGS)
const spaceCharacters = {
	ensp: '\u2002',
	emsp: '\u2003',
	nbsp: '\u00A0',
}

export function sanitizeRichText(html) {
	return DOMPurify.sanitize(String(html ?? ''), {
		ALLOWED_TAGS: RICH_TEXT_TAGS,
		ALLOW_DATA_ATTR: true,
		ALLOW_UNKNOWN_PROTOCOLS: false,
		FORBID_ATTR: ['srcdoc', 'formaction', 'xlink:href'],
	})
}

function appendRichTextNode(parent, node, spaceType) {
	if (!node || typeof node !== 'object') return

	if (node.type === 'text') {
		const replacement = spaceCharacters[spaceType] ?? ' '
		parent.append(document.createTextNode(String(node.text ?? '').replaceAll(' ', replacement)))
		return
	}

	const tagName = String(node.name ?? '').toLowerCase()
	if (!richTextTagSet.has(tagName)) return

	const element = document.createElement(tagName)
	if (node.attrs && typeof node.attrs === 'object' && !Array.isArray(node.attrs)) {
		for (const [name, value] of Object.entries(node.attrs)) {
			try {
				element.setAttribute(name, String(value ?? ''))
			}
			catch {
				// Invalid attribute names are ignored and never reach v-html.
			}
		}
	}

	for (const child of Array.isArray(node.children) ? node.children : []) {
		appendRichTextNode(element, child, spaceType)
	}
	parent.append(element)
}

export function renderRichTextNodes(nodes, spaceType) {
	const container = document.createElement('div')
	for (const node of nodes) {
		appendRichTextNode(container, node, spaceType)
	}
	return container.innerHTML
}
