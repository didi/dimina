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
			'  <custom-card />',
			'</view>',
		].join('\n'), '/pages/index/index.wxml', {
			'custom-card': '/components/card/index',
		})

		expect(warn).toHaveBeenCalledTimes(1)
		expect(warn.mock.calls[0][0]).toContain('<ad>')
		expect(warn.mock.calls[0][0]).toContain('/pages/index/index.wxml:2')
	})
})
