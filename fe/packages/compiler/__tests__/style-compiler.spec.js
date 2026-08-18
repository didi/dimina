import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { boostExternalClassSelectors, ensureImportSemicolons, normalizeCssUrlValue, normalizeRootStyleImports, resolveStyleImportPath } from '../src/core/style-compiler'
import { getAppStyleScopeId, getComponent, getPages, storeInfo } from '../src/env.js'
import { compileSS } from '../src/core/style-compiler.js'
import { compileML } from '../src/core/view-compiler.js'

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

describe('normalizeCssUrlValue', () => {
	it('应该将协议相对 URL 规范化为 https', () => {
		const input = 'url(//at.alicdn.com/iconfont.woff2?t=1)'
		expect(normalizeCssUrlValue(input, '/tmp/app/pages/index.wxss')).toBe('url(https://at.alicdn.com/iconfont.woff2?t=1)')
	})

	it('应该保留 https URL 不变', () => {
		const input = 'url("https://example.com/a.png")'
		expect(normalizeCssUrlValue(input, '/tmp/app/pages/index.wxss')).toBe(input)
	})
})

describe('external class selector specificity', () => {
	it('adds a higher-specificity alternative only for external-class roots', () => {
		const output = boostExternalClassSelectors('.loading[data-v-parent]{display:flex}', 'parent')

		expect(output).toContain('.loading[data-v-parent]')
		expect(output).toContain('.loading[data-v-parent][data-dd-external-class-scope~=data-v-parent]')
	})
})

describe('style compiler regressions', () => {
	let tempDir
	let outputDir
	let originalTargetPath

	function writeProjectFile(filePath, content) {
		const fullPath = path.join(tempDir, filePath)
		fs.mkdirSync(path.dirname(fullPath), { recursive: true })
		fs.writeFileSync(fullPath, content)
	}

	function prepareBaseProject(extraPageJson = {}) {
		writeProjectFile('app.json', JSON.stringify({
			pages: ['pages/home/index'],
		}))
		writeProjectFile('project.config.json', JSON.stringify({ appid: 'test-app-id' }))
		writeProjectFile('pages/home/index.wxml', '<view>home</view>')
		writeProjectFile('pages/home/index.wxss', '')
		writeProjectFile('pages/home/index.json', JSON.stringify(extraPageJson))
	}

	beforeEach(() => {
		originalTargetPath = process.env.TARGET_PATH
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'style-compiler-regression-'))
		outputDir = path.join(tempDir, 'dist')
		fs.mkdirSync(outputDir, { recursive: true })
		process.env.TARGET_PATH = outputDir
	})

	afterEach(() => {
		vi.restoreAllMocks()
		if (originalTargetPath) {
			process.env.TARGET_PATH = originalTargetPath
		}
		else {
			delete process.env.TARGET_PATH
		}

		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true })
		}
	})

	it('handles circular component dependency without emitting undefined', async () => {
		prepareBaseProject({
			usingComponents: { 'comp-a': '/components/a' },
		})

		writeProjectFile('components/a.json', JSON.stringify({
			component: true,
			usingComponents: { 'comp-b': '/components/b' },
		}))
		writeProjectFile('components/a.wxss', '.a { color: red; }')
		writeProjectFile('components/b.json', JSON.stringify({
			component: true,
			usingComponents: { 'comp-a': '/components/a' },
		}))
		writeProjectFile('components/b.wxss', '.b { color: blue; }')

		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

		storeInfo(tempDir)
		await compileSS(getPages().mainPages, null, { completedTasks: 0 })

		const outputCss = fs.readFileSync(path.join(outputDir, 'main/pages_home_index.css'), 'utf-8')
		expect(outputCss).not.toContain('undefined')
		expect(outputCss).toContain('.a')
		expect(outputCss).toContain('.b')
		expect(warnSpy).not.toHaveBeenCalled()
	})

	it('keeps compiled rpx stable when page-meta changes the rem root size', async () => {
		prepareBaseProject()
		writeProjectFile('pages/home/index.wxml', '<page-meta root-font-size="system"/><view class="box"/>')
		writeProjectFile('pages/home/index.wxss', '.box { width: 750rpx; margin-left: -7.5rpx; font-size: 1rem; }')

		storeInfo(tempDir)
		await compileSS(getPages().mainPages, null, { completedTasks: 0 })

		const outputCss = fs.readFileSync(path.join(outputDir, 'main/pages_home_index.css'), 'utf-8')
		expect(outputCss).toContain('width:100vw')
		expect(outputCss).toContain('margin-left:-1vw')
		expect(outputCss).toContain('font-size:1rem')
		expect(outputCss).not.toContain('750rem')
	})

	it('preserves caller-before-child style order while emitting external-class override selectors', async () => {
		prepareBaseProject({
			usingComponents: { parent: '/components/parent' },
		})
		writeProjectFile('pages/home/index.wxss', '.page-style { color: black; }')
		writeProjectFile('components/parent.json', JSON.stringify({
			component: true,
			usingComponents: { child: '/components/child' },
		}))
		writeProjectFile('components/parent.wxss', '.parent-external { display: flex; }')
		writeProjectFile('components/child.json', JSON.stringify({ component: true }))
		writeProjectFile('components/child.wxss', '.child-internal { display: inline-flex; }')

		storeInfo(tempDir)
		await compileSS(getPages().mainPages, null, { completedTasks: 0 })

		const outputCss = fs.readFileSync(path.join(outputDir, 'main/pages_home_index.css'), 'utf-8')
		const childIndex = outputCss.indexOf('.child-internal')
		const parentIndex = outputCss.indexOf('.parent-external')
		const pageIndex = outputCss.indexOf('.page-style')

		expect(childIndex).toBeGreaterThanOrEqual(0)
		expect(parentIndex).toBeGreaterThan(pageIndex)
		expect(childIndex).toBeGreaterThan(parentIndex)
		expect(outputCss).toContain('data-dd-external-class-scope')
	})

	it('compiles a deep acyclic component dependency chain without truncation', async () => {
		const depth = 22
		prepareBaseProject({
			usingComponents: { 'comp-0': '/components/c0' },
		})

		for (let i = 0; i < depth; i++) {
			const usingComponents = i < depth - 1 ? { [`comp-${i + 1}`]: `/components/c${i + 1}` } : {}
			writeProjectFile(`components/c${i}.json`, JSON.stringify({
				component: true,
				usingComponents,
			}))
			writeProjectFile(`components/c${i}.wxss`, `.c${i} { width: ${i + 1}px; }`)
		}

		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

		storeInfo(tempDir)
		await compileSS(getPages().mainPages, null, { completedTasks: 0 })

		const outputCss = fs.readFileSync(path.join(outputDir, 'main/pages_home_index.css'), 'utf-8')
		expect(outputCss).not.toContain('undefined')
		expect(outputCss).toContain('.c0')
		expect(outputCss).toContain(`.c${depth - 1}`)
		expect(warnSpy).not.toHaveBeenCalled()
	})

	it('isolates cache by module id for same imported style path', async () => {
		prepareBaseProject({
			usingComponents: {
				'comp-a': '/components/a',
				'comp-b': '/components/b',
			},
		})

		writeProjectFile('components/shared.wxss', '.shared { color: green; }')
		writeProjectFile('components/a.json', JSON.stringify({ component: true }))
		writeProjectFile('components/a.wxss', '@import "./shared.wxss";')
		writeProjectFile('components/b.json', JSON.stringify({ component: true }))
		writeProjectFile('components/b.wxss', '@import "./shared.wxss";')

		storeInfo(tempDir)
		await compileSS(getPages().mainPages, null, { completedTasks: 0 })

		const compA = getComponent('/components/a')
		const compB = getComponent('/components/b')
		const outputCss = fs.readFileSync(path.join(outputDir, 'main/pages_home_index.css'), 'utf-8')

		expect(compA.id).toBeTruthy()
		expect(compB.id).toBeTruthy()
		expect(compA.id).not.toBe(compB.id)
		expect(outputCss).toContain(`data-v-${compA.id}`)
		expect(outputCss).toContain(`data-v-${compB.id}`)
	})

	it('aligns isolated, apply-shared, shared, and legacy addGlobalClass styles', async () => {
		prepareBaseProject({
			usingComponents: {
				isolated: '/components/isolated',
				'applied-json': '/components/applied-json',
				'shared-script': '/components/shared-script',
				'legacy-script': '/components/legacy-script',
			},
		})
		writeProjectFile('pages/home/index.wxss', 'view .page-target { color: black; }')

		writeProjectFile('components/isolated.json', JSON.stringify({ component: true }))
		writeProjectFile('components/isolated.wxss', '.isolated-style { color: red; }')
		writeProjectFile('components/applied-json.json', JSON.stringify({
			component: true,
			styleIsolation: 'apply-shared',
		}))
		writeProjectFile('components/applied-json.wxss', '.applied-style { color: blue; }')
		writeProjectFile('components/shared-script.json', JSON.stringify({ component: true }))
		writeProjectFile('components/shared-script.js', "Component({ options: { styleIsolation: 'shared' } })")
		writeProjectFile('components/shared-script.wxss', ':host { display: block; } .shared-style { color: green; }')
		writeProjectFile('components/legacy-script.json', JSON.stringify({ component: true }))
		writeProjectFile('components/legacy-script.js', 'Component({ options: { addGlobalClass: true } })')
		writeProjectFile('components/legacy-script.wxss', '.legacy-style { color: purple; }')

		storeInfo(tempDir)
		const pages = getPages()
		await compileSS(pages.mainPages, null, { completedTasks: 0 })

		const page = pages.mainPages[0]
		const isolated = getComponent('/components/isolated')
		const applied = getComponent('/components/applied-json')
		const shared = getComponent('/components/shared-script')
		const legacy = getComponent('/components/legacy-script')
		const outputCss = fs.readFileSync(path.join(outputDir, 'main/pages_home_index.css'), 'utf-8')

		expect(isolated.styleIsolation).toBe('isolated')
		expect(applied.styleIsolation).toBe('apply-shared')
		expect(shared.styleIsolation).toBe('shared')
		expect(legacy.styleIsolation).toBe('apply-shared')
		expect(page.sharedStyleScopeIds).toEqual([shared.id])
		expect(outputCss).toContain(`.dd-view .page-target[data-v-${page.id}]`)
		expect(outputCss).toContain(`.isolated-style[data-v-${isolated.id}]`)
		expect(outputCss).toContain(`.applied-style[data-v-${applied.id}]`)
		expect(outputCss).toContain(`.shared-style[data-v-${shared.id}]`)
		expect(outputCss).toContain(`[data-dd-style-host~=${shared.id}][data-v-${shared.id}]`)
		expect(outputCss).toContain(`.legacy-style[data-v-${legacy.id}]`)
	})

	it('emits deterministic style metadata and keeps JSON precedence across nested shared components', async () => {
		prepareBaseProject({
			usingComponents: {
				conflict: '/components/conflict',
				nested: '/components/nested',
				'shared-ts': '/components/shared-ts',
				invalid: '/components/invalid',
			},
		})

		writeProjectFile('components/conflict.json', JSON.stringify({
			component: true,
			styleIsolation: 'apply-shared',
		}))
		writeProjectFile('components/conflict.js', "Component({ options: { styleIsolation: 'shared' } })")
		writeProjectFile('components/conflict.wxml', '<view>conflict</view>')

		writeProjectFile('components/shared-ts.json', JSON.stringify({ component: true }))
		writeProjectFile('components/shared-ts.ts', "Component({ options: { styleIsolation: 'shared' } })")
		writeProjectFile('components/shared-ts.wxml', '<view>shared</view>')

		writeProjectFile('components/nested.json', JSON.stringify({
			component: true,
			usingComponents: {
				shared: '/components/shared-ts',
			},
		}))
		writeProjectFile('components/nested.wxml', '<shared />')

		writeProjectFile('components/invalid.json', JSON.stringify({
			component: true,
			styleIsolation: 'unsupported-mode',
		}))
		writeProjectFile('components/invalid.wxml', '<view>invalid</view>')

		storeInfo(tempDir)
		const pages = getPages()
		const page = pages.mainPages[0]
		const conflict = getComponent('/components/conflict')
		const shared = getComponent('/components/shared-ts')
		const invalid = getComponent('/components/invalid')

		expect(conflict.styleIsolation).toBe('apply-shared')
		expect(shared.styleIsolation).toBe('shared')
		expect(invalid.styleIsolation).toBe('isolated')
		expect(page.appStyleScopeId).toBe(getAppStyleScopeId())
		// The same shared component is reachable both directly and through nested.
		expect(page.sharedStyleScopeIds).toEqual([shared.id])

		await compileML(pages.mainPages, null, { completedTasks: 0 })
		const output = fs.readFileSync(path.join(outputDir, 'main/pages_home_index.js'), 'utf-8')
		expect(output).toMatch(new RegExp(`path:\\s*["']pages/home/index["'][\\s\\S]{0,240}appStyleScopeId:\\s*["']${page.appStyleScopeId}["']`))
		expect(output).toMatch(new RegExp(`sharedStyleScopeIds:\\s*\\[["']${shared.id}["']\\]`))
		expect(output).toMatch(/path:\s*["']\/components\/conflict["'][\s\S]{0,240}styleIsolation:\s*["']apply-shared["']/)
		expect(output).toMatch(/path:\s*["']\/components\/shared-ts["'][\s\S]{0,240}styleIsolation:\s*["']shared["']/)
		expect(output).toMatch(/path:\s*["']\/components\/invalid["'][\s\S]{0,240}styleIsolation:\s*["']isolated["']/)
	})

	it('scopes app styles so isolated components do not receive them implicitly', async () => {
		prepareBaseProject()
		writeProjectFile('app.wxss', [
			'page { position: fixed; overflow: hidden; background: linear-gradient(#fff, #eee); }',
			'page .global-target { color: red; }',
		].join('\n'))

		storeInfo(tempDir)
		const appStyleScopeId = getAppStyleScopeId()
		await compileSS([{ path: 'app', id: appStyleScopeId }], null, { completedTasks: 0 })

		const outputCss = fs.readFileSync(path.join(outputDir, 'main/app.css'), 'utf-8')
		expect(outputCss).toContain(`.dd-page[data-v-${appStyleScopeId}]`)
		expect(outputCss).toContain('position:fixed')
		expect(outputCss).toContain('overflow:hidden')
		expect(outputCss).toContain('linear-gradient')
		expect(outputCss).toContain(`.dd-page .global-target[data-v-${appStyleScopeId}]`)
	})
})
