import { Parser } from 'htmlparser2'
import { isHTMLTag } from '@vue/shared'
import { isMainThread } from 'node:worker_threads'
import { getTemplateDirectivePrefixes, getViewScriptTags } from '../env.js'
import { supportedBuiltinComponents, supportedWxApis } from './compatibility-reference.js'
import { miniProgramBuiltinTags, tagWhiteList } from './utils.js'

let cachedReference = null
const warnedItems = new Set()
const pendingWarnings = []
const TEMPLATE_DIRECTIVE_NAMES = new Set([
	'if',
	'elif',
	'else',
	'for',
	'for-items',
	'for-item',
	'for-index',
	'key',
])
const KNOWN_NON_TEMPLATE_PREFIXES = new Set([
	'model',
	'change',
	'worklet',
	'data',
	'class',
	'style',
	'bind',
	'mut-bind',
	'catch',
	'capture-bind',
	'capture-mut-bind',
	'capture-catch',
	'mark',
	'generic',
	'extra-attr',
	'slot',
	'let',
])

function splitAttributePrefix(attributeName) {
	const segments = attributeName.split(':')
	if (segments.length !== 2 || !segments[0] || !segments[1]) {
		return null
	}
	return { prefix: segments[0], name: segments[1] }
}

function getTemplateDirectiveName(attributeName) {
	const attribute = splitAttributePrefix(attributeName)
	if (!attribute || !getTemplateDirectivePrefixes().includes(attribute.prefix)) {
		return null
	}
	return TEMPLATE_DIRECTIVE_NAMES.has(attribute.name) ? attribute.name : null
}

function getInvalidAttributePrefix(attributeName) {
	const attribute = splitAttributePrefix(attributeName)
	if (!attribute) return null
	const templatePrefixes = getTemplateDirectivePrefixes()
	if (templatePrefixes.includes(attribute.prefix)) {
		return TEMPLATE_DIRECTIVE_NAMES.has(attribute.name) ? null : attribute.prefix
	}
	if (KNOWN_NON_TEMPLATE_PREFIXES.has(attribute.prefix)) {
		return null
	}
	return attribute.prefix
}

function loadReference() {
	if (cachedReference) {
		return cachedReference
	}

	cachedReference = {
		supportedBuiltinComponents: new Set(supportedBuiltinComponents),
		supportedWxApis: new Set(supportedWxApis),
	}
	return cachedReference
}

function parseApiReference(content) {
	return {
		supportedBuiltinComponents: parseSingleColumnTable(content, '组件列表'),
		supportedWxApis: parseApiTable(content),
	}
}

function parseSingleColumnTable(content, heading) {
	const section = getSectionContent(content, heading)
	const items = new Set()

	for (const row of getMarkdownRows(section)) {
		if (row.length !== 1 || row[0] === heading.replace(/列表$/, '') || isDividerCell(row[0])) {
			continue
		}
		items.add(stripMarkdownCode(row[0]))
	}

	return items
}

function parseApiTable(content) {
	const section = getSectionContent(content, 'API 列表')
	const apis = new Set()
	let apiColumnIndex = -1

	for (const row of getMarkdownRows(section)) {
		if (row.includes('API 名称')) {
			apiColumnIndex = row.indexOf('API 名称')
			continue
		}

		if (apiColumnIndex === -1 || row.some(isDividerCell)) {
			continue
		}

		const apiName = stripMarkdownCode(row[apiColumnIndex])
		if (apiName) {
			apis.add(apiName)
		}
	}

	return apis
}

function getSectionContent(content, heading) {
	const sectionStart = content.indexOf(`## ${heading}`)
	if (sectionStart === -1) {
		return ''
	}

	const nextSection = content.indexOf('\n## ', sectionStart + 1)
	return nextSection === -1
		? content.slice(sectionStart)
		: content.slice(sectionStart, nextSection)
}

function getMarkdownRows(content) {
	return content
		.split('\n')
		.map(line => line.trim())
		.filter(line => line.startsWith('|') && line.endsWith('|'))
		.map(line => line.slice(1, -1).split('|').map(cell => cell.trim()))
}

function stripMarkdownCode(value = '') {
	return value.replace(/^`|`$/g, '').trim()
}

function isDividerCell(value = '') {
	return /^:?-{3,}:?$/.test(value.trim())
}

function getWxMemberName(node) {
	if (node?.type !== 'MemberExpression') {
		return null
	}

	if (node.object?.type !== 'Identifier' || node.object.name !== 'wx') {
		return null
	}

	if (!node.computed && node.property?.type === 'Identifier') {
		return node.property.name
	}

	if (
		node.computed
		&& (node.property?.type === 'StringLiteral' || node.property?.type === 'Literal')
		&& typeof node.property.value === 'string'
	) {
		return node.property.value
	}

	return null
}

function warnUnsupportedWxApi(apiName, filePath, line) {
	const { supportedWxApis } = loadReference()
	if (!apiName || supportedWxApis.has(apiName)) {
		return
	}

	const location = formatLocation(filePath, line)
	warnOnce('api', apiName, location, `[compat] Unsupported wx API: wx.${apiName}${location}`)
}

function warnUnsupportedComponent(tagName, filePath, line) {
	const { supportedBuiltinComponents } = loadReference()
	// 视图脚本标签（wxs、dds 及自定义标签）不是组件，需动态豁免。
	// 兼容性清单仅包含 wxs，因此还需在此放行 dds 和自定义标签，避免误报。
	if (
		!tagName
		|| supportedBuiltinComponents.has(tagName)
		|| tagWhiteList.includes(tagName)
		|| getViewScriptTags().includes(tagName)
	) {
		return
	}

	// glass-easel resolves registered mini-program components first, then falls
	// back to a native node for undeclared tags. Standard HTML follows that native
	// path, but known mini-program built-ins still need an unsupported warning.
	if (!miniProgramBuiltinTags.has(tagName) && isHTMLTag(tagName)) {
		return
	}

	const location = formatLocation(filePath, line)
	warnOnce('component', tagName, location, `[compat] Unsupported or undeclared component: <${tagName}>${location}`)
}

function checkTemplateCompatibility(content, filePath, components = {}) {
	let parser
	parser = new Parser(
		{
			onopentag(tagName, attrs) {
				const line = getLineByIndex(content, parser.startIndex)
				for (const attributeName of Object.keys(attrs)) {
					const invalidPrefix = getInvalidAttributePrefix(attributeName)
					if (invalidPrefix) {
						const location = formatLocation(filePath, line)
						warnOnce(
							'template-prefix',
							attributeName,
							location,
							`[compat] Invalid template attribute prefix: ${invalidPrefix}: (${attributeName})${location}`,
						)
					}
				}
				if (components?.[tagName]) {
					return
				}

				warnUnsupportedComponent(tagName, filePath, line)
			},
			onerror(error) {
				warnOnce(
					'parse',
					filePath,
					error.message,
					`[compat] Failed to parse template for compatibility diagnostics: ${filePath} ${error.message}`,
				)
			},
		},
		{
			xmlMode: true,
			lowerCaseTags: false,
			lowerCaseAttributeNames: false,
			withStartIndices: true,
		},
	)

	parser.write(content)
	parser.end()
}

function getLineByIndex(content, index) {
	if (typeof index !== 'number' || index < 0) {
		return null
	}

	let line = 1
	for (let i = 0; i < index; i++) {
		if (content.charCodeAt(i) === 10) {
			line++
		}
	}
	return line
}

function formatLocation(filePath, line) {
	if (!filePath) {
		return ''
	}
	return line ? ` (${filePath}:${line})` : ` (${filePath})`
}

function warnOnce(type, name, location, message) {
	const key = `${type}:${name}:${location}`
	if (warnedItems.has(key)) {
		return
	}
	warnedItems.add(key)
	if (isMainThread) {
		console.warn(message)
	}
	else {
		pendingWarnings.push(message)
	}
}

function takeCompatibilityWarnings() {
	return pendingWarnings.splice(0)
}

export {
	checkTemplateCompatibility,
	getTemplateDirectiveName,
	getWxMemberName,
	loadReference,
	parseApiReference,
	takeCompatibilityWarnings,
	warnUnsupportedWxApi,
}
