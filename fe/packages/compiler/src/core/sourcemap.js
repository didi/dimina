import { SourceMapConsumer, SourceMapGenerator } from 'source-map-js'

// 统一将模块包装为 modDefine 格式
function wrapModDefine(module) {
	const code = module.code.endsWith('\n') ? module.code : module.code + '\n'
	const extraLine = module.extraInfoCode || ''
	const header = `modDefine('${module.path}', function(require, module, exports) {\n${extraLine}`
	const footer = '});\n'
	return { header, code, footer }
}

// 合并多个模块的 sourcemap 到一份 bundle sourcemap
function mergeSourcemap(compileRes) {
	const smg = new SourceMapGenerator({ file: 'logic.js' })
	let bundleCode = ''
	// generatedLine (1-based) + lineOffset = bundle 中的实际行号
	let lineOffset = 0

	for (const module of compileRes) {
		const { header, code, footer } = wrapModDefine(module)

		bundleCode += header
		const headerLineCount = header.split('\n').length - 1
		lineOffset += headerLineCount

		if (module.map) {
			const moduleMap = JSON.parse(module.map)
			const smc = new SourceMapConsumer(moduleMap)

			smc.eachMapping((mapping) => {
				if (mapping.source == null) return
				smg.addMapping({
					generated: {
						line: mapping.generatedLine + lineOffset,
						column: mapping.generatedColumn,
					},
					original: {
						line: mapping.originalLine,
						column: mapping.originalColumn,
					},
					source: mapping.source,
					name: mapping.name,
				})
			})

			if (moduleMap.sourcesContent) {
				moduleMap.sources.forEach((src, i) => {
					smg.setSourceContent(src, moduleMap.sourcesContent[i])
				})
			}
		}

		bundleCode += code
		lineOffset += code.split('\n').length - 1

		bundleCode += footer
		lineOffset += footer.split('\n').length - 1
	}

	return { bundleCode, sourcemap: smg.toString() }
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

export { mergeSourcemap, remapSourcemap }
