import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '../../../..')
const docPath = path.join(repoRoot, 'docs/API-Reference.md')
const outputPath = path.resolve(scriptDir, '../src/common/compatibility-reference.js')
const checkOnly = process.argv.includes('--check')
const sourceLabel = path.relative(repoRoot, docPath)
const outputLabel = path.relative(repoRoot, outputPath)

const content = fs.readFileSync(docPath, 'utf-8')

const reference = {
	supportedBuiltinComponents: parseSingleColumnTable(content, '组件列表'),
	supportedWxApis: parseApiTable(content),
}

const output = `// Generated from docs/API-Reference.md.
// Keep this file in sync by running: pnpm --filter @dimina/compiler sync:compat

const supportedBuiltinComponents = ${formatArray(reference.supportedBuiltinComponents)}

const supportedWxApis = ${formatArray(reference.supportedWxApis)}

export {
\tsupportedBuiltinComponents,
\tsupportedWxApis,
}
`

const currentOutput = fs.existsSync(outputPath)
	? fs.readFileSync(outputPath, 'utf-8')
	: ''
const summary = `${reference.supportedBuiltinComponents.length} components, ${reference.supportedWxApis.length} APIs`

if (checkOnly) {
	if (currentOutput !== output) {
		console.error(`[compat] Out of sync: ${sourceLabel} -> ${outputLabel}`)
		console.error('[compat] Run: pnpm --filter @dimina/compiler sync:compat')
		process.exitCode = 1
	}
	else {
		console.log(`[compat] In sync: ${sourceLabel} -> ${outputLabel} (${summary})`)
	}
}
else if (currentOutput === output) {
	console.log(`[compat] Already in sync: ${sourceLabel} -> ${outputLabel} (${summary})`)
}
else {
	fs.writeFileSync(outputPath, output)
	console.log(`[compat] Synced: ${sourceLabel} -> ${outputLabel} (${summary})`)
}

function parseSingleColumnTable(markdown, heading) {
	const section = getSectionContent(markdown, heading)
	const items = []

	for (const row of getMarkdownRows(section)) {
		if (row.length !== 1 || row[0] === heading.replace(/列表$/, '') || isDividerCell(row[0])) {
			continue
		}
		items.push(stripMarkdownCode(row[0]))
	}

	return items
}

function parseApiTable(markdown) {
	const section = getSectionContent(markdown, 'API 列表')
	const apis = []
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
			apis.push(apiName)
		}
	}

	return apis
}

function getSectionContent(markdown, heading) {
	const sectionStart = markdown.indexOf(`## ${heading}`)
	if (sectionStart === -1) {
		return ''
	}

	const nextSection = markdown.indexOf('\n## ', sectionStart + 1)
	return nextSection === -1
		? markdown.slice(sectionStart)
		: markdown.slice(sectionStart, nextSection)
}

function getMarkdownRows(markdown) {
	return markdown
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

function formatArray(values) {
	return `[
${values.map(value => `\t${JSON.stringify(value)},`).join('\n')}
]`
}
