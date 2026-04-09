import { describe, expect, it } from 'vitest'
import { ensureImportSemicolons, normalizeRootStyleImports, removeBaseComponentScope, resolveStyleImportPath } from '../src/core/style-compiler'

describe('ensureImportSemicolons', () => {
	it('should add semicolons to @import statements that do not have them', () => {
		const input = `@import url("style1.css")
@import url("style2.css");
@import "style3.css"
@import "style4.css";`

		const expected = `@import url("style1.css");
@import url("style2.css");
@import "style3.css";
@import "style4.css";`

		expect(ensureImportSemicolons(input)).toEqual(expected)
	})

	it('should not modify @import statements that already have semicolons', () => {
		const input = `@import url("style1.css");
@import "style2.css";`

		expect(ensureImportSemicolons(input)).toEqual(input)
	})

	it('should handle @import statements with comments', () => {
		const input = `/* Comment */
@import url("style1.css") /* inline comment */
@import "style2.css"; /* another comment */`

		const expected = `/* Comment */
@import url("style1.css") /* inline comment */;
@import "style2.css"; /* another comment */`

		expect(ensureImportSemicolons(input)).toEqual(expected)
	})

	it('should handle complex CSS with multiple @import statements', () => {
		const input = `/* Header styles */
@import url("header.css")

body {
  margin: 0;
  padding: 0;
}

@import "footer.css"

.container {
  max-width: 1200px;
}`

		const expected = `/* Header styles */
@import url("header.css");

body {
  margin: 0;
  padding: 0;
}

@import "footer.css";

.container {
  max-width: 1200px;
}`

		expect(ensureImportSemicolons(input)).toEqual(expected)
	})

	it('should return the original CSS if there are no @import statements', () => {
		const input = `body {
  margin: 0;
  padding: 0;
}

.container {
  max-width: 1200px;
}`

		expect(ensureImportSemicolons(input)).toEqual(input)
	})

	it('should handle empty input', () => {
		expect(ensureImportSemicolons('')).toEqual('')
	})
})

describe('removeBaseComponentScope', () => {
	const moduleId = '7a7a37b1'

	it('应该移除基础组件选择器的 scoped 属性', async () => {
		const input = `.dd-input[data-v-${moduleId}] { color: red; }`
		const expected = `.dd-input { color: red; }`
		
		const result = await removeBaseComponentScope(input, moduleId)
		expect(result).toEqual(expected)
	})

	it('应该处理多个基础组件选择器', async () => {
		const input = `
.dd-input[data-v-${moduleId}] { color: red; }
.dd-button[data-v-${moduleId}] { padding: 10px; }
.dd-view[data-v-${moduleId}] { display: block; }
		`.trim()
		
		const expected = `
.dd-input { color: red; }
.dd-button { padding: 10px; }
.dd-view { display: block; }
		`.trim()
		
		const result = await removeBaseComponentScope(input, moduleId)
		expect(result).toEqual(expected)
	})

	it('应该保留非基础组件选择器的 scoped 属性', async () => {
		const input = `
.dd-input[data-v-${moduleId}] { color: red; }
.custom-class[data-v-${moduleId}] { color: blue; }
		`.trim()
		
		const expected = `
.dd-input { color: red; }
.custom-class[data-v-${moduleId}] { color: blue; }
		`.trim()
		
		const result = await removeBaseComponentScope(input, moduleId)
		expect(result).toEqual(expected)
	})

	it('应该处理复合选择器', async () => {
		const input = `.dd-input.active[data-v-${moduleId}] { color: red; }`
		const expected = `.dd-input.active { color: red; }`
		
		const result = await removeBaseComponentScope(input, moduleId)
		expect(result).toEqual(expected)
	})

	it('应该处理后代选择器', async () => {
		const input = `.container .dd-input[data-v-${moduleId}] { color: red; }`
		const expected = `.container .dd-input { color: red; }`
		
		const result = await removeBaseComponentScope(input, moduleId)
		expect(result).toEqual(expected)
	})

	it('应该处理伪类选择器', async () => {
		const input = `.dd-input:focus[data-v-${moduleId}] { border-color: blue; }`
		const expected = `.dd-input:focus { border-color: blue; }`
		
		const result = await removeBaseComponentScope(input, moduleId)
		expect(result).toEqual(expected)
	})

	it('应该处理多个类名的组合', async () => {
		const input = `
.dd-input[data-v-${moduleId}].dd-button[data-v-${moduleId}] { color: red; }
		`.trim()
		
		const expected = `
.dd-input.dd-button { color: red; }
		`.trim()
		
		const result = await removeBaseComponentScope(input, moduleId)
		expect(result).toEqual(expected)
	})

	it('应该处理没有 scoped 属性的基础组件', async () => {
		const input = `.dd-input { color: red; }`
		
		const result = await removeBaseComponentScope(input, moduleId)
		expect(result).toEqual(input)
	})

	it('当 moduleId 为空时应该返回原始 CSS', async () => {
		const input = `.dd-input[data-v-${moduleId}] { color: red; }`
		
		const result = await removeBaseComponentScope(input, '')
		expect(result).toEqual(input)
	})

	it('当 moduleId 为 null 时应该返回原始 CSS', async () => {
		const input = `.dd-input[data-v-${moduleId}] { color: red; }`
		
		const result = await removeBaseComponentScope(input, null)
		expect(result).toEqual(input)
	})

	it('应该处理混合的基础组件和自定义选择器', async () => {
		const input = `
.dd-input[data-v-${moduleId}] { color: red; }
.custom-wrapper .dd-button[data-v-${moduleId}] { padding: 10px; }
.custom-class[data-v-${moduleId}] { margin: 5px; }
.dd-view[data-v-${moduleId}] .child { display: flex; }
		`.trim()
		
		const expected = `
.dd-input { color: red; }
.custom-wrapper .dd-button { padding: 10px; }
.custom-class[data-v-${moduleId}] { margin: 5px; }
.dd-view .child { display: flex; }
		`.trim()
		
		const result = await removeBaseComponentScope(input, moduleId)
		expect(result).toEqual(expected)
	})

	it('应该处理所有白名单中的基础组件', async () => {
		const components = ['input', 'button', 'view', 'text', 'image', 'checkbox', 'radio']
		
		const input = components
			.map(tag => `.dd-${tag}[data-v-${moduleId}] { color: red; }`)
			.join('\n')
		
		const expected = components
			.map(tag => `.dd-${tag} { color: red; }`)
			.join('\n')
		
		const result = await removeBaseComponentScope(input, moduleId)
		expect(result).toEqual(expected)
	})
})

describe('style import path helpers', () => {
	it('应该将根路径 import 解析到小程序项目根目录', () => {
		const result = resolveStyleImportPath('/tmp/app/pages/home/index.less', '/variable.less', '/tmp/app')
		expect(result.endsWith('/variable.less')).toBe(true)
		expect(result.includes('/pages/home/')).toBe(false)
	})

	it('应该将根路径 less import 重写为绝对路径', () => {
		const result = normalizeRootStyleImports('@import "/variable.less";', '/tmp/app')
		expect(result).toContain('/variable.less')
		expect(result).not.toContain('@import "/variable.less";')
	})
})
