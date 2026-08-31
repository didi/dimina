import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkTemplateCompatibility, getWxMemberName, loadReference, parseApiReference, warnUnsupportedWxApi } from '../src/common/compatibility.js'

describe('compatibility diagnostics', () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('keeps bundled compatibility reference in sync with API reference markdown', () => {
		const content = fs.readFileSync(path.resolve(import.meta.dirname, '../../../../docs/API-Reference.md'), 'utf-8')
		const parsedReference = parseApiReference(content)
		const bundledReference = loadReference()

		expect([...bundledReference.supportedBuiltinComponents].sort()).toEqual(
			[...parsedReference.supportedBuiltinComponents].sort(),
		)
		expect([...bundledReference.supportedWxApis].sort()).toEqual(
			[...parsedReference.supportedWxApis].sort(),
		)
	})

	it('parses supported APIs and components from API reference markdown', () => {
		const reference = parseApiReference([
			'## 组件列表',
			'| 组件 |',
			'|------|',
			'| view |',
			'| button |',
			'',
			'## API 列表',
			'| 分类 | API 名称 | Android | iOS | Harmony | Web |',
			'|------|----------|---------|-----|---------|-----|',
			'| 基础 | canIUse | ✓ | ✓ | ✓ | ✗ |',
			'| 界面 | showToast | ✓ | ✓ | ✓ | ✓ |',
			'',
			'## 其他',
		].join('\n'))

		expect(reference.supportedBuiltinComponents.has('view')).toBe(true)
		expect(reference.supportedBuiltinComponents.has('button')).toBe(true)
		expect(reference.supportedWxApis.has('canIUse')).toBe(true)
		expect(reference.supportedWxApis.has('showToast')).toBe(true)
	})

	it('detects direct wx member names', () => {
		expect(getWxMemberName({
			type: 'MemberExpression',
			object: { type: 'Identifier', name: 'wx' },
			property: { type: 'Identifier', name: 'getUserProfile' },
			computed: false,
		})).toBe('getUserProfile')

		expect(getWxMemberName({
			type: 'MemberExpression',
			object: { type: 'Identifier', name: 'wx' },
			property: { type: 'StringLiteral', value: 'getUserProfile' },
			computed: true,
		})).toBe('getUserProfile')
	})

	it('warns for unsupported wx APIs and keeps supported APIs quiet', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

		warnUnsupportedWxApi('canIUse', '/pages/index/index.js', 1)
		warnUnsupportedWxApi('createCanvas', '/game.js', 2)
		warnUnsupportedWxApi('getUserProfile', '/pages/index/index.js', 2)

		expect(warn).toHaveBeenCalledTimes(1)
		expect(warn.mock.calls[0][0]).toContain('wx.getUserProfile')
		expect(warn.mock.calls[0][0]).toContain('/pages/index/index.js:2')
	})

	it('warns for unsupported template components but skips declared custom components', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

		checkTemplateCompatibility([
			'<view>',
			'  <ad unit-id="demo" />',
			'  <audio src="demo.mp3" />',
			'  <custom-card />',
			'</view>',
		].join('\n'), '/pages/index/index.wxml', {
			'custom-card': '/components/card/index',
		})

		expect(warn).toHaveBeenCalledTimes(2)
		expect(warn.mock.calls[0][0]).toContain('<ad>')
		expect(warn.mock.calls[0][0]).toContain('/pages/index/index.wxml:2')
		expect(warn.mock.calls[1][0]).toContain('<audio>')
		expect(warn.mock.calls[1][0]).toContain('/pages/index/index.wxml:3')
	})

	it('keeps native WXML elements out of unsupported component diagnostics', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

		checkTemplateCompatibility([
			'<page-meta root-font-size="system" />',
			'<view>',
			'  <div><span><p>paragraph</p></span></div>',
			'  <strong><i>important</i></strong>',
			'  <em><b><small>emphasis</small></b></em>',
			'  <table><tbody><tr><td>cell</td></tr></tbody></table>',
			'  <unknown-element />',
			'</view>',
		].join('\n'), '/pages/index/index.wxml')

		expect(warn).toHaveBeenCalledTimes(1)
		expect(warn.mock.calls[0][0]).toContain('<unknown-element>')
		expect(warn.mock.calls[0][0]).not.toMatch(/<page-meta>|<div>|<span>|<p>|<strong>|<i>|<em>|<b>|<small>|<table>|<tbody>|<tr>|<td>/)
	})

	it('warns with the correct line number for tags scattered across many lines', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const lines = Array.from({ length: 20 }, (_, i) => `<text>${i}</text>`)
		lines[0] = '<ad unit-id="first" />'
		lines[19] = '<ad unit-id="last" />'
		checkTemplateCompatibility(lines.join('\n'), '/pages/scattered/index.wxml')

		expect(warn).toHaveBeenCalledTimes(2)
		expect(warn.mock.calls[0][0]).toContain('/pages/scattered/index.wxml:1)')
		expect(warn.mock.calls[1][0]).toContain('/pages/scattered/index.wxml:20)')
	})
})
