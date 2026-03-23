import { describe, it, expect } from 'vitest'
import { SourceMapConsumer, SourceMapGenerator } from 'source-map-js'
import { mergeSourcemap } from '../src/core/sourcemap.js'

/**
 * 创建一个简单的 sourcemap JSON 字符串，映射每行代码到源文件对应行
 * @param {string} sourceFile 源文件路径
 * @param {string} code 代码内容
 * @param {string} [sourceContent] 源文件内容（嵌入到 sourcesContent）
 */
function makeSimpleSourcemap(sourceFile, code, sourceContent) {
	const smg = new SourceMapGenerator({ file: '' })
	const lines = code.split('\n')
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].length === 0) continue
		smg.addMapping({
			generated: { line: i + 1, column: 0 },
			original: { line: i + 1, column: 0 },
			source: sourceFile,
		})
	}
	if (sourceContent) {
		smg.setSourceContent(sourceFile, sourceContent)
	}
	return smg.toString()
}

/**
 * 解析 bundleCode 中第 N 行的内容（1-based）
 */
function getLine(bundleCode, lineNum) {
	return bundleCode.split('\n')[lineNum - 1]
}

/**
 * 从 sourcemap JSON 中收集所有映射，返回 { generatedLine, generatedColumn, originalLine, originalColumn, source }[]
 */
function collectMappings(sourcemapJson) {
	const smc = new SourceMapConsumer(JSON.parse(sourcemapJson))
	const mappings = []
	smc.eachMapping((m) => {
		mappings.push({
			generatedLine: m.generatedLine,
			generatedColumn: m.generatedColumn,
			originalLine: m.originalLine,
			originalColumn: m.originalColumn,
			source: m.source,
		})
	})
	return mappings
}

describe('mergeSourcemap', () => {
	it('单模块 — 代码无尾部换行', () => {
		const code = 'var a = 1;\nvar b = 2;'  // 无尾部 \n
		const map = makeSimpleSourcemap('/src/app.js', code)

		const { bundleCode, sourcemap } = mergeSourcemap([
			{ path: 'app', code, map },
		])

		// bundle 结构: line1=modDefine header, line2=var a, line3=var b, line4=});
		expect(getLine(bundleCode, 1)).toContain('modDefine(')
		expect(getLine(bundleCode, 2)).toBe('var a = 1;')
		expect(getLine(bundleCode, 3)).toBe('var b = 2;')
		expect(getLine(bundleCode, 4)).toBe('});')

		const mappings = collectMappings(sourcemap)
		// line 1 of code -> generated line 2 in bundle
		const m1 = mappings.find(m => m.originalLine === 1)
		expect(m1.generatedLine).toBe(2)
		// line 2 of code -> generated line 3 in bundle
		const m2 = mappings.find(m => m.originalLine === 2)
		expect(m2.generatedLine).toBe(3)
	})

	it('单模块 — 代码有尾部换行', () => {
		const code = 'var a = 1;\nvar b = 2;\n'  // 有尾部 \n
		const map = makeSimpleSourcemap('/src/app.js', code)

		const { bundleCode, sourcemap } = mergeSourcemap([
			{ path: 'app', code, map },
		])

		// 尾部 \n 规范化后不应产生多余空行
		expect(getLine(bundleCode, 1)).toContain('modDefine(')
		expect(getLine(bundleCode, 2)).toBe('var a = 1;')
		expect(getLine(bundleCode, 3)).toBe('var b = 2;')
		expect(getLine(bundleCode, 4)).toBe('});')

		const mappings = collectMappings(sourcemap)
		expect(mappings.find(m => m.originalLine === 1).generatedLine).toBe(2)
		expect(mappings.find(m => m.originalLine === 2).generatedLine).toBe(3)
	})

	it('带 extraInfoCode 的模块 — 行号偏移正确', () => {
		const code = 'var x = 42;\n'
		const map = makeSimpleSourcemap('/src/page.js', code)
		const extraInfoCode = 'globalThis.__extraInfo = {"page":true};\n'

		const { bundleCode, sourcemap } = mergeSourcemap([
			{ path: 'pages/index', code, map, extraInfoCode },
		])

		// line1=modDefine header, line2=extraInfoCode, line3=var x, line4=});
		expect(getLine(bundleCode, 1)).toContain('modDefine(')
		expect(getLine(bundleCode, 2)).toContain('__extraInfo')
		expect(getLine(bundleCode, 3)).toBe('var x = 42;')
		expect(getLine(bundleCode, 4)).toBe('});')

		const mappings = collectMappings(sourcemap)
		// code line 1 应映射到 bundle line 3（跳过 header + extraInfoCode）
		expect(mappings.find(m => m.originalLine === 1).generatedLine).toBe(3)
	})

	it('带多行 extraInfoCode — 行号偏移正确', () => {
		const code = 'console.log("hello");\nconsole.log("world");\n'
		const map = makeSimpleSourcemap('/src/page.js', code)
		const extraInfoCode = 'globalThis.__extraInfo = {\n  "components": {}\n};\n'

		const { bundleCode, sourcemap } = mergeSourcemap([
			{ path: 'pages/index', code, map, extraInfoCode },
		])

		// line1=modDefine, line2-4=extraInfoCode(3 lines), line5=hello, line6=world, line7=});
		expect(getLine(bundleCode, 1)).toContain('modDefine(')
		expect(getLine(bundleCode, 5)).toBe('console.log("hello");')
		expect(getLine(bundleCode, 6)).toBe('console.log("world");')

		const mappings = collectMappings(sourcemap)
		expect(mappings.find(m => m.originalLine === 1).generatedLine).toBe(5)
		expect(mappings.find(m => m.originalLine === 2).generatedLine).toBe(6)
	})

	it('多模块 — 第二个模块行号偏移正确', () => {
		const code1 = 'var a = 1;\n'
		const map1 = makeSimpleSourcemap('/src/mod1.js', code1)
		const code2 = 'var b = 2;\nvar c = 3;\n'
		const map2 = makeSimpleSourcemap('/src/mod2.js', code2)

		const { bundleCode, sourcemap } = mergeSourcemap([
			{ path: 'mod1', code: code1, map: map1 },
			{ path: 'mod2', code: code2, map: map2 },
		])

		// mod1: line1=header, line2=var a, line3=});
		// mod2: line4=header, line5=var b, line6=var c, line7=});
		expect(getLine(bundleCode, 2)).toBe('var a = 1;')
		expect(getLine(bundleCode, 5)).toBe('var b = 2;')
		expect(getLine(bundleCode, 6)).toBe('var c = 3;')

		const mappings = collectMappings(sourcemap)
		// mod1 mappings
		const mod1Mappings = mappings.filter(m => m.source === '/src/mod1.js')
		expect(mod1Mappings.find(m => m.originalLine === 1).generatedLine).toBe(2)
		// mod2 mappings
		const mod2Mappings = mappings.filter(m => m.source === '/src/mod2.js')
		expect(mod2Mappings.find(m => m.originalLine === 1).generatedLine).toBe(5)
		expect(mod2Mappings.find(m => m.originalLine === 2).generatedLine).toBe(6)
	})

	it('多模块 + extraInfoCode 组合', () => {
		const code1 = 'var a = 1;\n'
		const map1 = makeSimpleSourcemap('/src/mod1.js', code1)
		const code2 = 'var b = 2;\n'
		const map2 = makeSimpleSourcemap('/src/mod2.js', code2)

		const { bundleCode, sourcemap } = mergeSourcemap([
			{ path: 'mod1', code: code1, map: map1, extraInfoCode: 'globalThis.__e1 = {};\n' },
			{ path: 'mod2', code: code2, map: map2, extraInfoCode: 'globalThis.__e2 = {};\n' },
		])

		// mod1: line1=header, line2=extra, line3=var a, line4=});
		// mod2: line5=header, line6=extra, line7=var b, line8=});
		expect(getLine(bundleCode, 3)).toBe('var a = 1;')
		expect(getLine(bundleCode, 7)).toBe('var b = 2;')

		const mappings = collectMappings(sourcemap)
		expect(mappings.find(m => m.source === '/src/mod1.js' && m.originalLine === 1).generatedLine).toBe(3)
		expect(mappings.find(m => m.source === '/src/mod2.js' && m.originalLine === 1).generatedLine).toBe(7)
	})

	it('无 sourcemap 的模块不产生映射', () => {
		const { bundleCode, sourcemap } = mergeSourcemap([
			{ path: 'app', code: 'var a = 1;\n' },
		])

		expect(bundleCode).toContain('var a = 1;')
		expect(bundleCode).toContain('modDefine(')
		const mappings = collectMappings(sourcemap)
		expect(mappings.length).toBe(0)
	})

	it('嵌入 sourcesContent', () => {
		const code = 'var a = 1;\n'
		const originalSource = 'const a: number = 1;\n'
		const map = makeSimpleSourcemap('/src/app.ts', code, originalSource)

		const { sourcemap } = mergeSourcemap([
			{ path: 'app', code, map },
		])

		const parsed = JSON.parse(sourcemap)
		expect(parsed.sourcesContent).toBeDefined()
		expect(parsed.sourcesContent[0]).toBe(originalSource)
	})
})
