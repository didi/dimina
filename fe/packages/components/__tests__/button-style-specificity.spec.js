import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const BUTTON_FILE = fileURLToPath(new URL('../src/component/button/Button.vue', import.meta.url))

function getBlock(source, tagName) {
	const match = source.match(new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)</${tagName}>`))
	return match?.[1] ?? ''
}

function collectStyleRules(styleBlock) {
	const rules = []
	let index = 0

	while (index < styleBlock.length) {
		const open = styleBlock.indexOf('{', index)
		if (open === -1) break

		const selector = styleBlock.slice(index, open).trim()
		let depth = 1
		let close = open + 1
		while (close < styleBlock.length && depth > 0) {
			const char = styleBlock[close]
			if (char === '{') depth += 1
			if (char === '}') depth -= 1
			close += 1
		}

		if (selector && !selector.includes('}') && !selector.startsWith('@')) {
			rules.push({
				selector,
				body: styleBlock.slice(open + 1, close - 1),
			})
		}

		index = close
	}

	return rules
}

function getRuleBody(rules, selector) {
	const rule = rules.find(item => item.selector === selector)
	expect(rule, `missing style rule: ${selector}`).toBeDefined()
	return rule.body
}

describe('Button built-in style specificity', () => {
	const source = fs.readFileSync(BUTTON_FILE, 'utf-8')
	const template = getBlock(source, 'template')
	const style = getBlock(source, 'style')
	const rules = collectStyleRules(style)

	it('does not rely on :where() for Android WebView compatibility', () => {
		expect(style).not.toContain(':where(')
	})

	it('exposes class modifiers for styled button states', () => {
		expect(template).toContain(`\`dd-button--\${type}\``)
		expect(template).toContain("size === 'mini' && 'dd-button--mini'")
		expect(template).toContain("plainParsed && 'dd-button--plain'")
		expect(template).toContain("disabledParsed && 'dd-button--disabled'")
		expect(template).toContain("loadingParsed && 'dd-button--loading'")
	})

	it('keeps class-based styles for important state combinations', () => {
		expect(getRuleBody(rules, '.dd-button--primary')).toContain('background-color: #1aad19')
		expect(getRuleBody(rules, '.dd-button--disabled.dd-button--primary')).toContain('background-color: #9ed99d')
		expect(getRuleBody(rules, '.dd-button--primary.dd-button--plain')).toContain('border: 1px solid #1aad19')
		expect(getRuleBody(rules, '.dd-button--primary.dd-button--plain.dd-button--disabled')).toContain('border-color: rgba(0, 0, 0, 0.2)')
		expect(getRuleBody(rules, '.dd-button--loading.dd-button--primary.dd-button--plain')).toContain('background-color: transparent')
		expect(getRuleBody(rules, '.button-hover.dd-button--primary.dd-button--plain')).toContain('border-color: rgba(26, 173, 25, 0.6)')
	})

	it('does not keep legacy attribute selectors for class-backed states', () => {
		expect(style).not.toContain(".dd-button[type='primary']")
		expect(style).not.toContain(".dd-button[type='primary'][plain]")
		expect(style).not.toContain(".dd-button[disabled][type='primary']")
		expect(style).not.toContain(".dd-button[size='mini']")
		expect(style).not.toContain('.dd-button[loading]')
		expect(style).not.toContain(".button-hover[type='primary']")
		expect(style).not.toContain('.button-hover[plain]')
	})
})
