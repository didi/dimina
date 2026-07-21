import { SourceMapConsumer, SourceMapGenerator } from 'source-map-js'

// 统一将模块包装为 modDefine 格式
function wrapModDefine(module) {
	const code = module.code.endsWith('\n') ? module.code : module.code + '\n'
	const extraLine = module.extraInfoCode || ''
	const header = `modDefine('${module.path}', function(require, module, exports) {\n${extraLine}`
	const footer = '});\n'
	return { header, code, footer }
}

function appendSourceMap(smg, map, lineOffset, columnOffset) {
	const mapObject = typeof map === 'string' ? JSON.parse(map) : map
	const consumer = new SourceMapConsumer(mapObject)

	consumer.eachMapping((mapping) => {
		if (mapping.source == null || mapping.originalLine == null || mapping.originalColumn == null) {
			return
		}

		smg.addMapping({
			generated: {
				line: mapping.generatedLine + lineOffset,
				column: mapping.generatedColumn + (mapping.generatedLine === 1 ? columnOffset : 0),
			},
			original: {
				line: mapping.originalLine,
				column: mapping.originalColumn,
			},
			source: mapping.source,
			name: mapping.name,
		})
	})

	if (mapObject.sourcesContent) {
		mapObject.sources.forEach((source, index) => {
			smg.setSourceContent(source, mapObject.sourcesContent[index])
		})
	}
}

function advanceGeneratedPosition(position, code) {
	const lines = code.split('\n')
	if (lines.length === 1) {
		position.column += code.length
		return
	}

	position.line += lines.length - 1
	position.column = lines.at(-1).length
}

function concatSourcemap(chunks, file = '') {
	const smg = new SourceMapGenerator({ file })
	const position = { line: 1, column: 0 }
	let code = ''

	for (const chunk of chunks) {
		const chunkCode = typeof chunk === 'string' ? chunk : chunk.code
		if (typeof chunk !== 'string' && chunk.map) {
			appendSourceMap(smg, chunk.map, position.line - 1, position.column)
		}

		code += chunkCode
		advanceGeneratedPosition(position, chunkCode)
	}

	return { code, sourcemap: smg.toString() }
}

function createLineSourcemap(generatedCode, source, sourceContent, startLine = 1) {
	const smg = new SourceMapGenerator({ file: source })
	const generatedLineCount = generatedCode.split('\n').length
	const sourceLineCount = Math.max(1, sourceContent.split('\n').length)

	for (let line = 1; line <= generatedLineCount; line++) {
		smg.addMapping({
			generated: { line, column: 0 },
			original: {
				line: Math.min(sourceLineCount, startLine + line - 1),
				column: 0,
			},
			source,
		})
	}
	smg.setSourceContent(source, sourceContent)
	return JSON.parse(smg.toString())
}

// 合并多个模块的 sourcemap 到一份 bundle sourcemap
function mergeSourcemap(compileRes, file = 'logic.js') {
	const chunks = []

	for (const module of compileRes) {
		const { header, code, footer } = wrapModDefine(module)
		chunks.push(header, { code, map: module.map }, footer)
	}

	const { code: bundleCode, sourcemap } = concatSourcemap(chunks, file)
	return { bundleCode, sourcemap }
}

// 将两步 sourcemap 串联，nextMap 的 original 会继续映射回 prevMap 的 original
function remapSourcemap(nextMap, prevMap) {
	if (!nextMap) {
		return prevMap
	}
	if (!prevMap) {
		return nextMap
	}

	const nextMapObj = typeof nextMap === 'string' ? JSON.parse(nextMap) : nextMap
	const prevMapObj = typeof prevMap === 'string' ? JSON.parse(prevMap) : prevMap
	const smg = new SourceMapGenerator({ file: nextMapObj.file || prevMapObj.file || '' })
	const prevSmc = new SourceMapConsumer(prevMapObj)
	const nextSmc = new SourceMapConsumer(nextMapObj)

	nextSmc.eachMapping((mapping) => {
		if (mapping.source == null || mapping.originalLine == null || mapping.originalColumn == null) {
			return
		}

		const original = prevSmc.originalPositionFor({
			line: mapping.originalLine,
			column: mapping.originalColumn,
		})
		if (original.source == null || original.line == null || original.column == null) {
			return
		}

		smg.addMapping({
			generated: {
				line: mapping.generatedLine,
				column: mapping.generatedColumn,
			},
			original: {
				line: original.line,
				column: original.column,
			},
			source: original.source,
			name: original.name || mapping.name,
		})
	})

	if (prevMapObj.sourcesContent) {
		prevMapObj.sources.forEach((src, i) => {
			smg.setSourceContent(src, prevMapObj.sourcesContent[i])
		})
	}

	return smg.toString()
}

export { concatSourcemap, createLineSourcemap, mergeSourcemap, remapSourcemap }
