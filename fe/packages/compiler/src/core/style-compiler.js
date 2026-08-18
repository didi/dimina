import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isMainThread, parentPort } from 'node:worker_threads'
import { compileStyle } from '@vue/compiler-sfc'
import autoprefixer from 'autoprefixer'
import cssnano from 'cssnano'
import less from 'less'
import postcss from 'postcss'
import selectorParser from 'postcss-selector-parser'
import * as sass from 'sass'
import { collectAssets, resolveAssetSourcePath, tagWhiteList, transformRpx } from '../common/utils.js'
import { getAppId, getComponent, getContentByPath, getDependencyGraph, getStyleExts, getTargetPath, getWorkPath, resetStoreInfo } from '../env.js'
import { concatSourcemap, createLineSourcemap, remapSourcemap } from './sourcemap.js'

const compileRes = new Map()

if (!isMainThread) {
	parentPort.on('message', async ({ pages, storeInfo, sourcemap }) => {
		try {
			resetStoreInfo(storeInfo)

			const progress = {
				_completedTasks: 0,
				get completedTasks() {
					return this._completedTasks
				},
				set completedTasks(value) {
					this._completedTasks = value

					parentPort.postMessage({ completedTasks: this._completedTasks })
				},
			}

			await compileSS(pages.mainPages, null, progress, { sourcemap })

			for (const [root, subPages] of Object.entries(pages.subPages)) {
				await compileSS(subPages.info, root, progress, { sourcemap })
			}

			// Worker 任务完成后清理缓存，释放内存
			compileRes.clear()

			parentPort.postMessage({
				success: true,
				dependencyGraph: getDependencyGraph().toJSON(),
			})
		}
		catch (error) {
			// 错误时也清理缓存
			compileRes.clear()

			parentPort.postMessage({
				success: false,
				error: {
					message: error.message,
					stack: error.stack,
					name: error.name,
					file: error.file,
					line: error.line,
					column: error.column,
					stage: error.stage,
				}
			})
		}
	})
}

/**
 *  编译样式文件
 */
async function compileSS(pages, root, progress, options = {}) {
	// page 样式
	for (const page of pages) {
		const result = await buildCompileCss(page, new Set(), options)
		let code = result.code
		const filename = `${page.path.replace(/\//g, '_')}`
		const outputDir = root
			? `${getTargetPath()}/${root}`
			: `${getTargetPath()}/main`
		if (!fs.existsSync(outputDir)) {
			fs.mkdirSync(outputDir, { recursive: true })
		}

		if (options.sourcemap) {
			const mapFileName = `${filename}.css.map`
			const map = JSON.parse(result.map)
			map.file = `${filename}.css`
			code += `\n/*# sourceMappingURL=${mapFileName} */\n`
			fs.writeFileSync(`${outputDir}/${mapFileName}`, JSON.stringify(map))
		}
		fs.writeFileSync(`${outputDir}/${filename}.css`, code)

		progress.completedTasks++
	}
}

async function buildCompileCss(module, compiledPaths = new Set(), options = {}) {
	const chunks = []
	const pendingModules = [module]

	while (pendingModules.length > 0) {
		const currentModule = pendingModules.pop()
		const currentPath = currentModule.path || currentModule.absolutePath

		// A component stylesheet only needs to be emitted once per page traversal.
		// Mark it before visiting children so self and mutual references close
		// naturally without a fixed depth limit.
		if (compiledPaths.has(currentPath)) {
			continue
		}
		compiledPaths.add(currentPath)
		const result = await enhanceCSS(currentModule, options)
		if (result.code) {
			chunks.push(result)
		}

		// Preserve the original depth-first, declaration-order traversal while
		// using an explicit stack instead of the JavaScript call stack.
		const graphDependencies = getDependencyGraph().getDirectDependencies(currentPath, 'component')
		const componentPaths = graphDependencies.length > 0
			? graphDependencies
			: Object.values(currentModule.usingComponents || {})
		for (let index = componentPaths.length - 1; index >= 0; index--) {
			const componentModule = getComponent(componentPaths[index])
			if (componentModule) {
				pendingModules.push(componentModule)
			}
		}
	}

	if (options.sourcemap) {
		const { code, sourcemap: map } = concatSourcemap(chunks)
		return { code, map }
	}
	return { code: chunks.map(chunk => chunk.code).join(''), map: null }
}

function createExternalClassPlugin(moduleId) {
	const scopeAttribute = `data-v-${moduleId}`
	const externalScopeAttribute = 'data-dd-external-class-scope'
	const processedRules = new WeakSet()
	return {
		postcssPlugin: 'dimina-external-class',
		Rule(rule) {
			if (processedRules.has(rule) || !moduleId || !rule.selector.includes(`[${scopeAttribute}]`)) {
				return
			}
			processedRules.add(rule)

			try {
				rule.selector = selectorParser((selectors) => {
					for (const selector of [...selectors.nodes]) {
						const boostedSelector = selector.clone()
						const scopeNodes = []
						boostedSelector.walkAttributes((attribute) => {
							if (attribute.attribute === scopeAttribute) {
								scopeNodes.push(attribute)
							}
						})

						const targetScope = scopeNodes.at(-1)
						if (!targetScope) {
							continue
						}

						targetScope.parent.insertAfter(targetScope, selectorParser.attribute({
							attribute: externalScopeAttribute,
							operator: '~=',
							quoteMark: '"',
							value: scopeAttribute,
						}))
						selectors.append(boostedSelector)
					}
				}).processSync(rule.selector)
			}
			catch (error) {
				throw rule.error(error.message, { plugin: 'dimina-external-class' })
			}
		},
	}
}

function boostExternalClassSelectors(cssCode, moduleId) {
	if (!moduleId || !cssCode) {
		return cssCode
	}

	return postcss([createExternalClassPlugin(moduleId)])
		.process(cssCode, { from: undefined }).css
}

function getStyleSourcePath(absolutePath) {
	const workPath = getWorkPath()
	if (absolutePath === workPath || absolutePath.startsWith(`${workPath}${path.sep}`)) {
		return `/${path.relative(workPath, absolutePath).split(path.sep).join('/')}`
	}
	return absolutePath.split(path.sep).join('/')
}

function createStyleCompileError(stage, absolutePath, cause) {
	if (cause?.name === 'StyleCompileError') {
		return cause
	}

	const line = cause?.line ?? (Number.isInteger(cause?.span?.start?.line) ? cause.span.start.line + 1 : undefined)
	const column = cause?.column ?? (Number.isInteger(cause?.span?.start?.column) ? cause.span.start.column + 1 : undefined)
	const file = getStyleSourcePath(absolutePath)
	const location = line == null
		? file
		: `${file}:${line}${column == null ? '' : `:${column}`}`
	const reason = cause?.reason || cause?.sassMessage || cause?.message || String(cause)
	const error = new Error(`[style:${stage}] ${location} ${reason}`, { cause })
	error.name = 'StyleCompileError'
	error.file = file
	error.line = line
	error.column = column
	error.stage = stage
	return error
}

function normalizePreprocessorMap(inputMap, absolutePath, inputCSS) {
	const map = typeof inputMap === 'string' ? JSON.parse(inputMap) : structuredClone(inputMap)
	const sourcePaths = map.sources.map((source) => {
		let resolvedPath = source
		if (source.startsWith('file:')) {
			resolvedPath = fileURLToPath(source)
		}
		else if (!path.isAbsolute(source)) {
			resolvedPath = path.resolve(path.dirname(absolutePath), source)
		}
		return resolvedPath
	})

	map.sources = sourcePaths.map(getStyleSourcePath)
	map.sourcesContent = map.sources.map((_, index) => {
		if (sourcePaths[index] === absolutePath) {
			return inputCSS
		}
		return map.sourcesContent?.[index] ?? null
	})
	return map
}

function getPostcssMapOptions(sourcemap, prev) {
	if (!sourcemap) {
		return false
	}
	return {
		inline: false,
		annotation: false,
		sourcesContent: true,
		prev,
	}
}

function createStyleTransformPlugin(module, absolutePath, importResults, options) {
	const processedRules = new WeakSet()
	return {
		postcssPlugin: 'dimina-style-transform',
		AtRule(node) {
			if (node.name !== 'import') {
				return
			}

			const importPath = node.params.replace(/^['"]|['"]$/g, '')
			const importFullPath = resolveStyleImportPath(absolutePath, importPath)
			node.remove()
			importResults.push(buildCompileCss({
				absolutePath: importFullPath,
				id: module.id,
				ownerPath: module.ownerPath || module.path,
			}, new Set(), options))
		},
		Rule(rule) {
			if (processedRules.has(rule)) {
				return
			}
			processedRules.add(rule)

			if (rule.selector.includes('::v-deep')) {
				rule.selector = rule.selector.replace(/::v-deep\s+(\S[^{]*)/g, ':deep($1)')
			}

			if (rule.selector.includes(':host')) {
				rule.selector = processHostSelector(rule.selector, module.id)
			}

			try {
				rule.selector = selectorParser((selectors) => {
					selectors.walkTags((tag) => {
						if (tagWhiteList.includes(tag.value)) {
							tag.value = `.dd-${tag.value}`
						}
					})
				}).processSync(rule.selector)
			}
			catch (error) {
				throw rule.error(error.message, { plugin: 'dimina-style-transform' })
			}
		},
		Comment(comment) {
			comment.remove()
		},
		Declaration(declaration) {
			declaration.value = normalizeCssUrlValue(
				declaration.value,
				absolutePath,
				module.ownerPath || module.path,
			)
			declaration.value = transformRpx(declaration.value)
		},
	}
}

async function enhanceCSS(module, options = {}) {
	const absolutePath = module.absolutePath ? module.absolutePath : getAbsolutePath(module.path)
	if (!absolutePath) {
		// 样式文件不存在
		return { code: '', map: null }
	}
	const graphOwnerPath = module.ownerPath || module.path
	if (graphOwnerPath) {
		getDependencyGraph().addFile(graphOwnerPath, absolutePath, 'style')
	}
	const cacheKey = `${absolutePath}::${module.id || ''}::${options.sourcemap ? 'map' : 'plain'}`

	const inputCSS = getContentByPath(absolutePath)
	if (!inputCSS) {
		return { code: '', map: null }
	}

	if (compileRes.has(cacheKey)) {
		return compileRes.get(cacheKey)
	}

	// 预处理器编译
	let processedCSS = normalizeRootStyleImports(inputCSS)
	let processedMap = options.sourcemap
		? createLineSourcemap(processedCSS, getStyleSourcePath(absolutePath), inputCSS)
		: null
	const ext = path.extname(absolutePath).toLowerCase()

	try {
		if (ext === '.less') {
			const result = await less.render(processedCSS, {
				filename: absolutePath,
				paths: [path.dirname(absolutePath), getWorkPath()],
				sourceMap: options.sourcemap
					? {
						outputSourceFiles: true,
						disableSourcemapAnnotation: true,
					}
					: undefined,
			})
			processedCSS = result.css
			if (options.sourcemap) {
				processedMap = normalizePreprocessorMap(result.map, absolutePath, inputCSS)
			}
		}
		else if (ext === '.scss' || ext === '.sass') {
			const result = sass.compileString(processedCSS, {
				loadPaths: [path.dirname(absolutePath), getWorkPath()],
				syntax: ext === '.sass' ? 'indented' : 'scss',
				url: options.sourcemap ? pathToFileURL(absolutePath) : undefined,
				sourceMap: !!options.sourcemap,
				sourceMapIncludeSources: !!options.sourcemap,
			})
			processedCSS = result.css
			if (options.sourcemap) {
				processedMap = normalizePreprocessorMap(result.sourceMap, absolutePath, inputCSS)
			}
		}
	}
	catch (error) {
		throw createStyleCompileError('preprocess', absolutePath, error)
	}

	const fixedCSS = ensureImportSemicolons(processedCSS)
	if (options.sourcemap && fixedCSS !== processedCSS) {
		const normalizeMap = createLineSourcemap(fixedCSS, absolutePath, processedCSS)
		processedMap = remapSourcemap(normalizeMap, processedMap)
	}

	const importResults = []
	let transformedResult
	try {
		transformedResult = await postcss([
			createStyleTransformPlugin(module, absolutePath, importResults, options),
		]).process(fixedCSS, {
			from: undefined,
			map: getPostcssMapOptions(options.sourcemap, processedMap),
		})
	} catch (error) {
		throw createStyleCompileError('transform', absolutePath, error)
	}

	// 样式隔离
	const moduleId = module.id
	let scopedResult
	try {
		scopedResult = compileStyle({
			source: transformedResult.css,
			filename: getStyleSourcePath(absolutePath),
			id: moduleId,
			scoped: !!moduleId,
			inMap: options.sourcemap ? transformedResult.map.toJSON() : undefined,
		})
		if (scopedResult.errors.length > 0) {
			throw scopedResult.errors[0]
		}
	}
	catch (error) {
		throw createStyleCompileError('scope', absolutePath, error)
	}

	let externalResult
	try {
		externalResult = await postcss([createExternalClassPlugin(moduleId)])
			.process(scopedResult.code, {
				from: undefined,
				map: getPostcssMapOptions(options.sourcemap, scopedResult.map),
			})
	}
	catch (error) {
		throw createStyleCompileError('external-class', absolutePath, error)
	}

	// 统一后处理：autoprefixer + 压缩
	let finalResult
	try {
		finalResult = await postcss([
			autoprefixer({ overrideBrowserslist: ['cover 99.5%'] }),
			cssnano()
		]).process(externalResult.css, {
			from: undefined,
			map: getPostcssMapOptions(options.sourcemap, externalResult.map?.toJSON()),
		})
	}
	catch (error) {
		throw createStyleCompileError('postprocess', absolutePath, error)
	}

	// 处理导入的样式
	const importedChunks = (await Promise.all(importResults)).filter(result => result.code)
	let result
	if (options.sourcemap) {
		const { code, sourcemap: map } = concatSourcemap([
			...importedChunks,
			{ code: finalResult.css, map: finalResult.map.toString() },
		])
		result = { code, map }
	}
	else {
		result = {
			code: importedChunks.map(chunk => chunk.code).join('') + finalResult.css,
			map: null,
		}
	}

	compileRes.set(cacheKey, result)

	return result
}

function normalizeCssUrlValue(value, absolutePath, graphOwnerPath) {
	return value.replace(/url\(([^)]+)\)/g, (fullMatch, rawUrl) => {
		const cleanedUrl = rawUrl.trim().replace(/^['"]|['"]$/g, '')

		if (!cleanedUrl || cleanedUrl.startsWith('data:image')) {
			return fullMatch
		}

		if (cleanedUrl.startsWith('//')) {
			return `url(https:${cleanedUrl})`
		}

		if (/^(https?:|blob:|data:)/.test(cleanedUrl)) {
			return fullMatch
		}

		if (graphOwnerPath && /\.(?:png|jpe?g|gif|svg)(?:\?.*)?$/.test(cleanedUrl)) {
			getDependencyGraph().addFile(
				graphOwnerPath,
				resolveAssetSourcePath(getWorkPath(), absolutePath, cleanedUrl),
				'style',
			)
		}
		const realSrc = collectAssets(getWorkPath(), absolutePath, cleanedUrl, getTargetPath(), getAppId())
		return `url(${realSrc})`
	})
}

function getAbsolutePath(modulePath) {
	const workPath = getWorkPath()
	const src = modulePath.startsWith('/') ? modulePath : `/${modulePath}`

	for (const ssType of getStyleExts()) {
		const ssFullPath = `${workPath}${src}${ssType}`
		if (fs.existsSync(ssFullPath)) {
			return ssFullPath
		}

		const indexSsFullPath = `${workPath}${src}/index${ssType}`
		if (fs.existsSync(indexSsFullPath)) {
			return indexSsFullPath
		}
	}
}

function resolveStyleImportPath(absolutePath, importPath, workPath = getWorkPath()) {
	if (importPath.startsWith('/')) {
		return path.join(workPath, importPath)
	}
	return path.resolve(path.dirname(absolutePath), importPath)
}

function normalizeRootStyleImports(source, workPath = getWorkPath()) {
	return source.replace(/(@import\s+(?:\(.*?\)\s*)?(?:url\()?['"])(\/[^'")]+)(['"]\)?)/g, (_, prefix, importPath, suffix) => {
		return `${prefix}${path.join(workPath, importPath)}${suffix}`
	})
}

/**
 * Ensures that all @import statements in CSS end with semicolons
 * @param {string} css - The CSS content to process
 * @returns {string} - The processed CSS with semicolons added to @import statements as needed
 */
function ensureImportSemicolons(css) {
	// 查找所有未以分号结尾的@import语句，并在它们后面添加分号
	return css.replace(/@import[^;\n]*$/gm, (match) => {
		// Check if the match already ends with a semicolon
		return match.endsWith(';') ? match : `${match};`
	})
}

/**
 * 处理 :host 选择器，将其转换为适合组件根节点的选择器
 * @param {string} selector - 包含 :host 的选择器
 * @param {string} moduleId - 组件的模块ID
 * @returns {string} - 转换后的选择器
 */
function processHostSelector(selector, moduleId) {
	const hostSelector = `[data-dd-style-host~="${moduleId}"]`

	return selector
		// :host(.class) 选择带有特定类的组件根节点
		.replace(/:host\(([^)]+)\)/g, `${hostSelector}$1`)
		// 宿主标记与 data-v 样式作用域分离，避免 shared 作用域扩散后 :host 误命中页面节点。
		.replace(/:host(?![\w-])/g, hostSelector)
}

export { boostExternalClassSelectors, compileSS, ensureImportSemicolons, normalizeCssUrlValue, normalizeRootStyleImports, processHostSelector, resolveStyleImportPath }
