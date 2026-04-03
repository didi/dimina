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

export { mergeSourcemap }
