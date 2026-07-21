import fs from 'node:fs'
import path from 'node:path'
import { isMainThread, parentPort } from 'node:worker_threads'
import { parseSync } from 'oxc-parser'
import { walk } from 'oxc-walker'
import MagicString from 'magic-string'
import { compileTemplate } from '@vue/compiler-sfc'
import * as cheerio from 'cheerio'
import { transform } from 'esbuild'
import * as htmlparser2 from 'htmlparser2'
import { checkTemplateCompatibility, getTemplateDirectiveName, takeCompatibilityWarnings } from '../common/compatibility.js'
import { toMiniProgramModuleId } from '../common/path-utils.js'
import { collectAssets, getAbsolutePath, resolveAssetSourcePath, tagWhiteList, transformRpx } from '../common/utils.js'
import { getAppId, getComponent, getContentByPath, getDependencyGraph, getTargetPath, getTemplateExts, getViewScriptExts, getViewScriptTags, getWorkPath, resetStoreInfo } from '../env.js'
import { parseBindings } from '../common/expression-parser.js'
import { concatSourcemap, createLineSourcemap, mergeSourcemap, remapSourcemap } from './sourcemap.js'

/**
 * 根据扩展名列表生成匹配尾部扩展名的正则，如 ['.wxs', '.qds'] -> /(\.wxs|\.qds)$/
 */
function buildExtStripRegex(exts) {
	const alt = exts.map(e => e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
	return new RegExp(`(${alt})$`)
}

/**
 * 移除视图脚本文件路径末尾的扩展名，支持 .wxs 和自定义扩展名
 */
function stripViewScriptExt(p) {
	return p.replace(buildExtStripRegex(getViewScriptExts()), '')
}

/**
 * 解析 JavaScript 代码
 * @param {string} code
 * @param {string} filename
 * @param {'module'|'script'} sourceType
 * @returns {*} Oxc Program AST
 */
function parseJs(code, filename = 'view-compiler.js', sourceType = 'module') {
	return parseSync(filename, code, {
		sourceType,
		lang: 'js',
	}).program
}

/**
 * 如果顶层是单个表达式语句，则只返回表达式源码
 * @param {string} code
 * @param {*} ast - Oxc Program AST
 * @returns {string} Program code or the source of the single top-level expression.
 */
function getProgramCode(code, ast) {
	const statement = ast.body?.[0]
	if (ast.body?.length === 1 && statement?.type === 'ExpressionStatement') {
		return code.slice(statement.expression.start, statement.expression.end)
	}
	return code
}

function isStringLiteral(node) {
	return node?.type === 'StringLiteral' || (node?.type === 'Literal' && typeof node.value === 'string')
}

function getStringLiteralRawValue(node) {
	if (!isStringLiteral(node)) {
		return ''
	}

	if (typeof node.raw === 'string') {
		return node.raw.slice(1, -1)
	}
	return String(node.value)
}

function getSource(code, node) {
	return code.slice(node.start, node.end)
}

function applyCodeReplacements(source, replacements) {
	if (replacements.length === 0) {
		return source
	}

	const selected = []
	const byLargestRange = [...replacements].sort((a, b) => {
		const lengthDiff = (b.end - b.start) - (a.end - a.start)
		return lengthDiff || b.start - a.start
	})

	for (const replacement of byLargestRange) {
		const overlaps = selected.some(item =>
			replacement.start < item.end && item.start < replacement.end
		)
		if (!overlaps) {
			selected.push(replacement)
		}
	}

	const s = new MagicString(source)
	for (const replacement of selected.sort((a, b) => b.start - a.start)) {
		if (replacement.type === 'insert') {
			s.appendLeft(replacement.start, replacement.value)
		}
		else {
			s.overwrite(replacement.start, replacement.end, replacement.value)
		}
	}

	return s.toString()
}

/**
 * 为模板表达式中的成员访问补充空值保护，避免生成的 render 函数直接访问 null/undefined 属性
 * 例如: stickyProps.zIndex -> stickyProps?.zIndex
 * @param {string} expression
 * @returns {string} 添加了可选链操作符的表达式字符串
 */
function addOptionalChaining(expression) {
	if (!expression || typeof expression !== 'string') {
		return expression
	}

	try {
		const code = `(${expression})`
		const ast = parseJs(code)
		const insertions = []

		walk(ast, {
			enter(node) {
				if (node.type !== 'MemberExpression' || node.optional) {
					return
				}

				if (node.computed) {
					const bracketIndex = code.lastIndexOf('[', node.property.start)
					if (bracketIndex >= 0) {
						insertions.push({
							type: 'insert',
							start: bracketIndex,
							end: bracketIndex,
							value: '?.',
						})
					}
				}
				else {
					const dotIndex = code.lastIndexOf('.', node.property.start)
					if (dotIndex >= 0) {
						insertions.push({
							type: 'insert',
							start: dotIndex,
							end: dotIndex,
							value: '?',
						})
					}
				}
			}
		})

		return applyCodeReplacements(code, insertions).slice(1, -1)
	} catch (error) {
		return expression
	}
}

function parseSafeBraceExp(exp) {
	return addOptionalChaining(parseBraceExp(exp))
}

function transformTextInterpolation(text) {
	if (!text || typeof text !== 'string' || !isWrappedByBraces(text)) {
		return text
	}

	return text.replace(braceRegex, (match, bracePart) => {
		if (!bracePart) {
			return match
		}
		const matchResult = bracePart.match(noBraceRegex)
		if (!matchResult) {
			return match
		}
		return `{{${addOptionalChaining(matchResult[1].trim())}}}`
	})
}

// 页面文件编译内容缓存
const compileResCache = new Map()

// wxs 模块注册表，用于记录确定的 wxs 模块
const wxsModuleRegistry = new Set()

// wxs 文件路径映射表，用于快速查找模块对应的文件路径
const wxsFilePathMap = new Map()

let enableSourcemap = false

if (!isMainThread) {
	parentPort.on('message', async ({ pages, storeInfo, sourcemap }) => {
		try {
			resetStoreInfo(storeInfo)
			enableSourcemap = !!sourcemap

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

			await compileML(pages.mainPages, null, progress)

			for (const [root, subPages] of Object.entries(pages.subPages)) {
				await compileML(subPages.info, root, progress)
			}

			// Worker 任务完成后清理所有缓存，释放内存
			compileResCache.clear()
			wxsModuleRegistry.clear()
			wxsFilePathMap.clear()

			parentPort.postMessage({
				success: true,
				compatibilityWarnings: takeCompatibilityWarnings(),
				dependencyGraph: getDependencyGraph().toJSON(),
			})
		}
		catch (error) {
			// 错误时也清理缓存
			compileResCache.clear()
			wxsModuleRegistry.clear()
			wxsFilePathMap.clear()

			parentPort.postMessage({
				success: false,
				error: {
					message: error.message,
					stack: error.stack,
					name: error.name
				}
			})
		}
	})
}

/**
 * 编译页面视图文件
 */
async function compileML(pages, root, progress) {
	const workPath = getWorkPath()

	// 初始化 wxs 文件路径映射
	initWxsFilePathMap(workPath)

	for (const page of pages) {
		const scriptRes = new Map()
		const sourceMapRes = new Map()
		buildCompileView(page, false, scriptRes, new Set(), new Set(), sourceMapRes)
		const filename = `${page.path.replace(/\//g, '_')}`
		const outputDir = root
			? `${getTargetPath()}/${root}`
			: `${getTargetPath()}/main`
		if (!fs.existsSync(outputDir)) {
			fs.mkdirSync(outputDir, { recursive: true })
		}

		if (enableSourcemap) {
			const compileRes = [...scriptRes.entries()].map(([modulePath, code]) => ({
				path: modulePath,
				code,
				map: sourceMapRes.get(modulePath),
			}))
			const sourcemapFileName = `${filename}.js.map`
			const { bundleCode, sourcemap } = mergeSourcemap(compileRes, `${filename}.js`)
			fs.writeFileSync(`${outputDir}/${filename}.js`, `${bundleCode}//# sourceMappingURL=${sourcemapFileName}\n`)
			fs.writeFileSync(`${outputDir}/${sourcemapFileName}`, sourcemap)
		}
		else {
			let mergeRender = ''
			for (const [key, value] of scriptRes.entries()) {
				const amdFormat = `modDefine('${key}', function(require, module, exports) {
			${value}
			});`
				try {
					const { code: minifiedCode } = await transform(amdFormat, {
						minify: true,
						target: ['es2020'],
						platform: 'browser',
					})
					mergeRender += minifiedCode
				}
				catch (error) {
					const location = error.errors?.[0]?.location
					const sourceLines = amdFormat.split('\n')
					const sourceHint = location?.line
						? sourceLines
							.slice(Math.max(0, location.line - 3), location.line + 2)
							.map((line, index) => `${Math.max(1, location.line - 2) + index}: ${line.trim()}`)
							.join('\n')
						: ''
					error.message = `视图模块 ${key} 转换失败: ${error.message}${sourceHint ? `\n${sourceHint}` : ''}`
					throw error
				}
			}
			fs.writeFileSync(`${outputDir}/${filename}.js`, mergeRender)
		}

		// 单个页面编译完成后清理缓存，释放内存
		scriptRes.clear()
		sourceMapRes.clear()

		progress.completedTasks++
	}
}

/**
 * 初始化 wxs 文件路径映射
 * @param {string} workPath - 工作路径
 */
function initWxsFilePathMap(workPath) {
	// 清空现有映射
	wxsFilePathMap.clear()

	// 扫描 miniprogram_npm 目录下的所有 wxs 文件
	const npmDir = path.join(workPath, 'miniprogram_npm')
	if (fs.existsSync(npmDir)) {
		scanWxsFiles(npmDir, workPath)
	}
}

/**
 * 递归扫描目录下的所有 wxs 文件
 * @param {string} dir - 目录路径
 * @param {string} workPath - 工作路径
 */
function scanWxsFiles(dir, workPath) {
	try {
		const items = fs.readdirSync(dir)

		for (const item of items) {
			const fullPath = path.join(dir, item)
			const stat = fs.statSync(fullPath)

			if (stat.isDirectory()) {
				// 递归扫描子目录
				scanWxsFiles(fullPath, workPath)
			} else if (stat.isFile() && getViewScriptExts().some(ext => item.endsWith(ext))) {
				// 处理 wxs 文件
				const relativePath = stripViewScriptExt(fullPath.replace(workPath, ''))
				const moduleName = relativePath.replace(/[\/\\@\-]/g, '_').replace(/^_/, '')

				// 建立模块名到文件路径的映射
				wxsFilePathMap.set(moduleName, fullPath)
			}
		}
	} catch (error) {
		// 忽略无法读取的目录
	}
}

/**
 * 注册 wxs 模块
 * @param {string} modulePath - 模块路径
 */
function registerWxsModule(modulePath) {
	wxsModuleRegistry.add(modulePath)
}

function getTemplateCompilerOptions(scopeId) {
	return {
		// https://template-explorer.vuejs.org/
		prefixIdentifiers: true,
		hoistStatic: false,
		cacheHandlers: true,
		scopeId,
		mode: 'function',
		inline: true,
		// transTag has already rewritten registered built-ins and custom
		// components to the reserved dd-* namespace. Every remaining unknown WXML
		// tag follows glass-easel's unused-native-node fallback instead of Vue's
		// component resolution.
		isCustomElement: tag => !tag.startsWith('dd-'),
	}
}

/**
 * 检查是否为已注册的 wxs 模块
 * @param {string} modulePath - 模块路径
 * @returns {boolean} wxs 模块是否已注册
 */
function isRegisteredWxsModule(modulePath) {
	return wxsModuleRegistry.has(modulePath)
}

function buildCompileView(module, isComponent = false, scriptRes, activePaths = new Set(), inheritedTemplatePaths = new Set(), sourceMapRes = new Map()) {
	const currentPath = module.path

	// Recursive component declarations are valid. Stop only the duplicate edge
	// on the current traversal path; the runtime keeps the recursive mapping.
	if (activePaths.has(currentPath)) {
		return
	}
	activePaths.add(currentPath)

	// 收集所有 wxs 模块（包括组件的）
	const allScriptModules = []

	// 首先编译当前模块
	const currentInstruction = compileModule(module, isComponent, scriptRes, {
		skipTemplatePaths: isComponent ? inheritedTemplatePaths : new Set(),
		sourceMapRes,
	})
	if (currentInstruction && currentInstruction.scriptModule) {
		allScriptModules.push(...currentInstruction.scriptModule)
	}
	const childInheritedTemplatePaths = new Set(inheritedTemplatePaths)
	for (const tm of currentInstruction?.templateModule || []) {
		childInheritedTemplatePaths.add(tm.path)
	}

	if (module.usingComponents) {
		const graphDependencies = getDependencyGraph().getDirectDependencies(module.path, 'component')
		const componentDependencies = graphDependencies.length > 0
			? graphDependencies
			: Object.values(module.usingComponents)
		for (const componentInfo of componentDependencies) {
			const componentModule = getComponent(componentInfo)
			if (!componentModule) {
				continue
			}
			// 检查自依赖：当前模块已经完成本轮编译，只跳过重复编译；
			// render runtime 仍会保留该递归组件映射。
			if (componentModule.path === module.path) {
				continue
			}
			// 递归编译组件，并收集其 wxs 模块
			const componentInstruction = buildCompileView(componentModule, true, scriptRes, activePaths, childInheritedTemplatePaths, sourceMapRes)
			if (componentInstruction && componentInstruction.scriptModule) {
				// 将组件的 wxs 模块添加到当前模块的 wxs 模块列表中
				for (const sm of componentInstruction.scriptModule) {
					// 避免重复添加相同的模块
					if (!allScriptModules.find(existing => existing.path === sm.path)) {
						allScriptModules.push(sm)
					}
				}
			}
		}
	}

	// 如果这是页面（不是组件），需要重新编译以包含所有 wxs 模块
	if (!isComponent && allScriptModules.length > 0) {
		// 在重新编译之前，确保所有依赖模块都已添加到 scriptRes 中
		for (const sm of allScriptModules) {
			if (!scriptRes.has(sm.path)) {
				scriptRes.set(sm.path, sm.code)
			}
		}

		// 重新编译页面，包含所有收集到的 wxs 模块
		compileModuleWithAllWxs(module, scriptRes, allScriptModules, sourceMapRes)
	}

	activePaths.delete(currentPath)
	// 返回当前模块的指令信息（包含 wxs 模块）
	return { scriptModule: allScriptModules, templateModule: currentInstruction?.templateModule || [] }
}

/**
 * 编译页面及自定义组件，自定义组件可认为是特殊的页面
 * https://developers.weixin.qq.com/miniprogram/dev/framework/custom-component/
 * @param {*} module
 */
function compileModule(module, isComponent, scriptRes, options = {}) {
	const skipTemplatePaths = options.skipTemplatePaths || new Set()
	const sourceMapRes = options.sourceMapRes || new Map()
	const { tpl, instruction, sourceInfo } = toCompileTemplate(isComponent, module.path, module.usingComponents, module.componentPlaceholder)
	if (!tpl) {
		return null
	}
	const templateModule = instruction.templateModule || []
	const templateModuleForCompile = templateModule.filter(tm => !skipTemplatePaths.has(tm.path))
	const compileInstruction = {
		...instruction,
		templateModule: templateModuleForCompile,
	}

	// 检查是否有缓存的模板编译结果
	let useCache = false
	let cachedCode = null
	const canUseCache = skipTemplatePaths.size === 0

	if (canUseCache && !scriptRes.has(module.path) && compileResCache.has(module.path)) {
		const cacheData = compileResCache.get(module.path)
		// 如果缓存数据包含完整的编译信息，则使用缓存
		if (cacheData && typeof cacheData === 'object' && cacheData.code && cacheData.instruction) {
			cachedCode = cacheData.code
			useCache = true
			// 将缓存的 wxs 模块添加到当前页面的 scriptRes 中
			for (const sm of cacheData.instruction.scriptModule) {
				if (!scriptRes.has(sm.path)) {
					scriptRes.set(sm.path, sm.code)
				}
			}
		} else if (typeof cacheData === 'string') {
			// 兼容旧的缓存格式（只有代码字符串）
			cachedCode = cacheData
			useCache = true
		}
	}

	if (useCache && cachedCode) {
		scriptRes.set(module.path, cachedCode)
		const cachedMap = compileResCache.get(module.path)?.map
		if (enableSourcemap && cachedMap) {
			sourceMapRes.set(module.path, cachedMap)
		}

		// 即使使用缓存，也需要确保返回的 instruction 包含最新的 wxs 模块信息
		// 收集所有在 scriptRes 中的 wxs 模块（包括依赖模块）
		const allWxsModules = collectAllWxsModules(scriptRes, new Set(), instruction.scriptModule || [])

		// 将收集到的 wxs 模块添加到 instruction 中
		if (allWxsModules.length > 0) {
			// 合并现有的 scriptModule 和新收集的 wxs 模块
			const existingModules = instruction.scriptModule || []
			const mergedModules = [...existingModules]

			for (const wxsModule of allWxsModules) {
				// 避免重复添加相同的模块
				if (!mergedModules.find(existing => existing.path === wxsModule.path)) {
					mergedModules.push(wxsModule)
				}
			}

			instruction.scriptModule = mergedModules
		}

		// 返回更新后的 instruction，包含所有 wxs 模块
		return {
			...instruction,
			scriptModule: allWxsModules
		}
	}

	// 在编译前预处理模板，将 this. 替换为 _ctx.
	const processedTpl = tpl.replace(/\bthis\./g, '_ctx.')
	// https://play.vuejs.org/
	const tplCode = compileTemplate({
		source: processedTpl,
		filename: module.path, // 用于错误提示
		id: `data-v-${module.id}`,
		scoped: true,
		inMap: enableSourcemap
			? createLineSourcemap(processedTpl, sourceInfo.path, sourceInfo.content)
			: undefined,
		compilerOptions: getTemplateCompilerOptions(`data-v-${module.id}`),
	})

	const templateResults = []
	for (const tm of compileInstruction.templateModule) {
		const compiledTemplate = compileTemplate({
			source: tm.tpl,
			filename: tm.path,
			id: `data-v-${module.id}`,
			scoped: true,
			inMap: enableSourcemap && tm.sourceInfo
				? createLineSourcemap(tm.tpl, tm.sourceInfo.path, tm.sourceInfo.content, tm.sourceInfo.startLine)
				: undefined,
			compilerOptions: getTemplateCompilerOptions(`data-v-${module.id}`),
		})
		templateResults.push({
			path: tm.path,
			...insertWxsToRenderResult(compiledTemplate.code, compileInstruction.scriptModule, scriptRes, tm.path, compiledTemplate.map),
		})
	}

	const renderResult = insertWxsToRenderResult(tplCode.code, compileInstruction.scriptModule, scriptRes, module.path, tplCode.map)

	// 通过 component 字段标记该页面 以 Component 形式进行渲染或着以 Page 形式进行渲染
	// https://developers.weixin.qq.com/miniprogram/dev/framework/app-service/page.html
	// https://developers.weixin.qq.com/miniprogram/dev/framework/custom-component/component.html
	const moduleChunks = [`Module({
		path: '${module.path}',
		id: '${module.id}',
		appStyleScopeId: ${JSON.stringify(module.appStyleScopeId || null)},
		sharedStyleScopeIds: ${JSON.stringify(module.sharedStyleScopeIds || [])},
		styleIsolation: ${JSON.stringify(module.styleIsolation || 'isolated')},
		render: `, renderResult, `,
		usingComponents: ${JSON.stringify(module.usingComponents)},
		componentPlaceholder: ${JSON.stringify(module.componentPlaceholder || {})},
		customTabBar: ${JSON.stringify(module.customTabBar || null)},
		tplComponents: {`]
	for (const templateResult of templateResults) {
		moduleChunks.push(`'${templateResult.path}':`, templateResult, ',')
	}
	moduleChunks.push('},\n\t\t});')
	const { code, sourcemap: moduleMap } = concatSourcemap(moduleChunks, module.path)

	// 收集所有在 scriptRes 中的 wxs 模块（包括依赖模块）
	const allWxsModules = collectAllWxsModules(scriptRes, new Set(), compileInstruction.scriptModule || [])

	// 将收集到的 wxs 模块添加到 instruction 中
	if (allWxsModules.length > 0) {
		// 合并现有的 scriptModule 和新收集的 wxs 模块
		const existingModules = compileInstruction.scriptModule || []
		const mergedModules = [...existingModules]

		for (const wxsModule of allWxsModules) {
			// 避免重复添加相同的模块
			if (!mergedModules.find(existing => existing.path === wxsModule.path)) {
				mergedModules.push(wxsModule)
			}
		}

		compileInstruction.scriptModule = mergedModules
	}

	// 缓存编译结果，包含代码和更新后的指令信息
	const cacheData = {
		code,
		instruction: compileInstruction,
		map: enableSourcemap ? moduleMap : null,
	}
	if (canUseCache) {
		compileResCache.set(module.path, cacheData)
	}
	scriptRes.set(module.path, code)
	if (enableSourcemap) {
		sourceMapRes.set(module.path, moduleMap)
	}

	return {
		...compileInstruction,
		templateModule,
	}
}

/**
 * 处理 wxs 内容，包括注入全局方法、转换 constructor、处理 require 等
 * @param {string} wxsContent - wxs 代码内容
 * @param {string} wxsFilePath - wxs 文件路径（用于处理 require）
 * @param {Array} scriptModule - 脚本模块数组
 * @param {string} workPath - 工作路径
 * @param {string} filePath - 当前处理的文件路径
 * @returns {string} 处理后的 wxs 代码
 */
function processWxsContent(wxsContent, wxsFilePath, scriptModule, workPath, filePath, graphOwnerPath = filePath) {
	if (wxsFilePath && graphOwnerPath) {
		getDependencyGraph().addFile(graphOwnerPath, wxsFilePath, 'view')
	}
	let wxsAst
	try {
		wxsAst = parseJs(wxsContent, wxsFilePath || 'inline.wxs', 'script')
	} catch (error) {
		console.error(`[view] 解析 wxs 文件失败: ${wxsFilePath}`, error.message)
		return wxsContent // 返回原始内容
	}

	const replacements = []

	// 遍历并处理各种转换
	walk(wxsAst, {
		enter(node) {
			if (node.type === 'CallExpression') {
				const calleeName = node.callee?.name

				// https://developers.weixin.qq.com/miniprogram/dev/reference/wxs/06datatype.html#regexp
				// getRegExp -> 正则表达式字面量或 new RegExp 调用
				if (calleeName === 'getRegExp') {
					const args = node.arguments

					if (args.length > 0) {
						// 如果参数都是字符串字面量，直接转换为正则表达式字面量
						if (isStringLiteral(args[0]) && (!args[1] || isStringLiteral(args[1]))) {
							const pattern = getStringLiteralRawValue(args[0])
							const flags = args.length > 1 ? getStringLiteralRawValue(args[1]) : ''

							replacements.push({
								start: node.start,
								end: node.end,
								value: `/${pattern}/${flags}`,
							})
						}
						else {
							// 对于变量参数，转换为 new RegExp(pattern, flags) 调用
							const newRegExpArgs = args.map(arg => getSource(wxsContent, arg)).join(', ')
							replacements.push({
								start: node.start,
								end: node.end,
								value: `new RegExp(${newRegExpArgs})`,
							})
						}
					}
				}
				else if (calleeName === 'getDate') {
					// getDate -> new Date
					const args = node.arguments.map(arg => getSource(wxsContent, arg)).join(', ')
					replacements.push({
						start: node.start,
						end: node.end,
						value: `new Date(${args})`,
					})
				}
				// 处理 wxs 文件内部的 require 调用（仅对外部文件）
				else if (calleeName === 'require' && node.arguments.length > 0 && wxsFilePath) {
					const requirePath = node.arguments[0].value

					if (requirePath && typeof requirePath === 'string') {
						// 解析 wxs 内部的相对路径 require
						let resolvedWxsPath

						if (filePath && filePath.includes('/miniprogram_npm/')) {
							// 对于 npm 组件中的 wxs，需要特殊处理相对路径
							const currentWxsDir = path.dirname(wxsFilePath)
							resolvedWxsPath = path.resolve(currentWxsDir, requirePath)

							// 转换为相对于工作目录的路径，并移除视图脚本扩展名
							const relativePath = stripViewScriptExt(resolvedWxsPath.replace(workPath, ''))

							// 生成唯一的模块名（移除特殊字符）
							const moduleName = relativePath.replace(/[\/\\@\-]/g, '_').replace(/^_/, '')

							// 递归处理依赖的 wxs 文件
							processWxsDependency(resolvedWxsPath, moduleName, scriptModule, workPath, filePath, graphOwnerPath)

							// 替换 require 路径
							replacements.push({
								start: node.arguments[0].start,
								end: node.arguments[0].end,
								value: JSON.stringify(moduleName),
							})
						}
						else {
							// 对于普通组件，使用原有逻辑
							const currentWxsDir = path.dirname(wxsFilePath)
							resolvedWxsPath = path.resolve(currentWxsDir, requirePath)
							const relativePath = stripViewScriptExt(resolvedWxsPath.replace(workPath, ''))
							const depModuleName = relativePath.replace(/[\/\\@\-]/g, '_').replace(/^_/, '')

							// 递归处理依赖
							processWxsDependency(resolvedWxsPath, depModuleName, scriptModule, workPath, filePath, graphOwnerPath)

							// 替换 require 路径
							replacements.push({
								start: node.arguments[0].start,
								end: node.arguments[0].end,
								value: JSON.stringify(depModuleName),
							})
						}
					}
				}
			}

			if (node.type === 'MemberExpression') {
				// 处理 constructor 属性访问，模拟微信小程序 wxs 中 constructor 返回字符串的行为
				if (node.property?.name === 'constructor' && !node.computed) {
					const objectCode = getSource(wxsContent, node.object)
					replacements.push({
						start: node.start,
						end: node.end,
						value: `Object.prototype.toString.call(${objectCode}).slice(8, -1)`,
					})
				}
			}
		}
	})

	return applyCodeReplacements(wxsContent, replacements)
}

/**
 * 通过代码内容判断是否为 wxs 模块
 * @param {string} moduleCode - 模块代码
 * @param {string} modulePath - 模块路径（可选，用于路径判断）
 * @returns {boolean} 是否为 wxs 模块
 */
function isWxsModuleByContent(moduleCode, modulePath = '') {
	if (!moduleCode || typeof moduleCode !== 'string') {
		return false
	}

	if (modulePath && isRegisteredWxsModule(modulePath)) {
		return true
	}
	return false
}

// 递归处理 wxs 依赖
function processWxsDependency(wxsFilePath, moduleName, scriptModule, workPath, filePath, graphOwnerPath = filePath) {
	if (!fs.existsSync(wxsFilePath)) {
		console.warn(`[view] wxs 依赖文件不存在: ${wxsFilePath}`)
		return
	}

	// 检查是否已经处理过这个模块
	if (scriptModule.find(sm => sm.path === moduleName)) {
		return
	}

	const wxsContent = getContentByPath(wxsFilePath).trim()
	if (!wxsContent) {
		return
	}

	// 使用公共的处理函数
	const wxsCode = processWxsContent(wxsContent, wxsFilePath, scriptModule, workPath, filePath, graphOwnerPath)

	// 注册为 wxs 模块（因为这是 wxs 依赖，一定是 wxs 脚本）
	registerWxsModule(moduleName)

	scriptModule.push({
		path: moduleName,
		code: wxsCode,
	})
}

/**
 * 重新编译模块，包含所有收集到的 wxs 模块
 * @param {*} module
 * @param {*} scriptRes
 * @param {*} allScriptModules
 */
function compileModuleWithAllWxs(module, scriptRes, allScriptModules, sourceMapRes = new Map()) {
	const { tpl, instruction, sourceInfo } = toCompileTemplate(false, module.path, module.usingComponents, module.componentPlaceholder)
	if (!tpl) {
		return
	}

	// 合并所有 wxs 模块
	const mergedInstruction = {
		...instruction,
		scriptModule: allScriptModules
	}

	// 在编译前预处理模板，将 this. 替换为 _ctx.
	const processedTpl = tpl.replace(/\bthis\./g, '_ctx.')
	const tplCode = compileTemplate({
		source: processedTpl,
		filename: module.path,
		id: `data-v-${module.id}`,
		scoped: true,
		inMap: enableSourcemap
			? createLineSourcemap(processedTpl, sourceInfo.path, sourceInfo.content)
			: undefined,
		compilerOptions: getTemplateCompilerOptions(`data-v-${module.id}`),
	})

	const templateResults = []
	for (const tm of mergedInstruction.templateModule) {
		const compiledTemplate = compileTemplate({
			source: tm.tpl,
			filename: tm.path,
			id: `data-v-${module.id}`,
			scoped: true,
			inMap: enableSourcemap && tm.sourceInfo
				? createLineSourcemap(tm.tpl, tm.sourceInfo.path, tm.sourceInfo.content, tm.sourceInfo.startLine)
				: undefined,
			compilerOptions: getTemplateCompilerOptions(`data-v-${module.id}`),
		})
		templateResults.push({
			path: tm.path,
			...insertWxsToRenderResult(compiledTemplate.code, allScriptModules, scriptRes, tm.path, compiledTemplate.map),
		})
	}

	const renderResult = insertWxsToRenderResult(tplCode.code, allScriptModules, scriptRes, module.path, tplCode.map)

	const moduleChunks = [`Module({
		path: '${module.path}',
		id: '${module.id}',
		appStyleScopeId: ${JSON.stringify(module.appStyleScopeId || null)},
		sharedStyleScopeIds: ${JSON.stringify(module.sharedStyleScopeIds || [])},
		styleIsolation: ${JSON.stringify(module.styleIsolation || 'isolated')},
		render: `, renderResult, `,
		usingComponents: ${JSON.stringify(module.usingComponents)},
		componentPlaceholder: ${JSON.stringify(module.componentPlaceholder || {})},
		customTabBar: ${JSON.stringify(module.customTabBar || null)},
		tplComponents: {`]
	for (const templateResult of templateResults) {
		moduleChunks.push(`'${templateResult.path}':`, templateResult, ',')
	}
	moduleChunks.push('},\n\t\t});')
	const { code, sourcemap: moduleMap } = concatSourcemap(moduleChunks, module.path)

	// 更新缓存和结果
	const cacheData = {
		code,
		instruction: mergedInstruction,
		map: enableSourcemap ? moduleMap : null,
	}
	compileResCache.set(module.path, cacheData)
	scriptRes.set(module.path, code)
	if (enableSourcemap) {
		sourceMapRes.set(module.path, moduleMap)
	}
}

/**
 * 处理 include 节点的条件属性，并返回处理后的内容
 * @param {Object} $ - cheerio 实例
 * @param {Object} elem - include 元素
 * @param {string} includeContent - 要包含的内容
 * @returns {string} 处理后的 HTML 字符串
 */
function processIncludeConditionalAttrs($, elem, includeContent) {
	// 检查 include 元素是否有条件属性（:if, :elif, :else）
	const allAttrs = $(elem).attr()
	const conditionAttrs = {}
	let hasCondition = false

	// 遍历所有属性，查找以 :if, :elif, :else 结尾的属性
	for (const attrName in allAttrs) {
		if (['if', 'elif', 'else'].includes(getTemplateDirectiveName(attrName))) {
			conditionAttrs[attrName] = allAttrs[attrName]
			hasCondition = true
		}
	}

	if (hasCondition) {
		// 如果有条件属性，用 block 包裹内容并保留条件属性
		let blockAttrs = ''
		for (const attrName in conditionAttrs) {
			const attrValue = conditionAttrs[attrName]
			if (attrValue !== undefined && attrValue !== '') {
				blockAttrs += ` ${attrName}="${attrValue}"`
			} else {
				// 处理 :else 这种没有值的属性
				blockAttrs += ` ${attrName}`
			}
		}

		return `<block${blockAttrs}>${includeContent}</block>`
	} else {
		// 如果没有条件属性，直接返回内容（保持原有行为）
		return includeContent
	}
}

/**
 * 递归处理被引入文件中的组件 wxs 依赖
 * @param {*} content 被引入文件的内容
 * @param {*} includePath 被引入文件的路径
 * @param {*} scriptModule 用于收集 wxs 模块的数组
 * @param {*} components 当前可用的组件映射
 * @param {Set} processedPaths 已处理的路径集合，防止循环引用和栈溢出
 */
function processIncludedFileWxsDependencies(content, includePath, scriptModule, components, processedPaths = new Set()) {
	// 如果当前路径已经处理过，直接返回避免循环引用
	if (processedPaths.has(includePath)) {
		return
	}

	// 将当前路径添加到已处理集合中
	processedPaths.add(includePath)

	const $ = cheerio.load(content, {
		xmlMode: true,
		decodeEntities: false,
		_useHtmlParser2: true,
		// 减少内存占用的配置
		lowerCaseTags: false,
		lowerCaseAttributeNames: false,
	})

	// 查找所有组件标签
	const componentTags = new Set()

	// 遍历所有元素，查找组件标签
	$('*').each((_, elem) => {
		const tagName = elem.tagName
		if (components && components[tagName]) {
			componentTags.add(tagName)
		}
	})

	// 对每个组件，直接处理其 wxs 依赖（避免递归调用 buildCompileView）
	for (const tagName of componentTags) {
		const componentPath = components[tagName]
		const componentModule = getComponent(componentPath)
		if (componentModule) {
			// 检查组件路径是否已经处理过，避免循环引用
			if (processedPaths.has(componentModule.path)) {
				continue
			}

			// 直接获取组件的模板和 wxs 依赖，避免递归调用
			const componentTemplate = toCompileTemplate(true, componentModule.path, componentModule.usingComponents, componentModule.componentPlaceholder, processedPaths)

			if (componentTemplate && componentTemplate.instruction && componentTemplate.instruction.scriptModule) {
				// 将组件的 wxs 模块添加到当前的 scriptModule 中
				for (const sm of componentTemplate.instruction.scriptModule) {
					// 避免重复添加相同的模块
					if (!scriptModule.find(existing => existing.path === sm.path)) {
						scriptModule.push(sm)
					}
				}
			}
		}
	}
}

/**
 * 转换成底层框架模板
 * @param {*} isComponent
 * @param {*} path
 * @param {*} components
 * @param {*} componentPlaceholder
 * @param {Set} processedPaths 已处理的路径集合,防止循环引用和栈溢出
 */
function toCompileTemplate(isComponent, path, components, componentPlaceholder, processedPaths = new Set()) {
	const workPath = getWorkPath()
	const fullPath = getViewPath(workPath, path)
	if (!fullPath) {
		return { tpl: undefined }
	}
	getDependencyGraph().addFile(path, fullPath, 'view')
	const sourcePath = toMiniProgramModuleId(fullPath, workPath)
		.replace(buildExtStripRegex(getTemplateExts()), '')
	const diagnosticSource = fullPath.startsWith(workPath)
		? fullPath.slice(workPath.length)
		: path
	const originalContent = getContentByPath(fullPath)
	let content = originalContent
	if (!content.trim()) {
		// 空文件内容，防止编译出错
		content = '<block></block>'
	}
	else {
		checkTemplateCompatibility(content, diagnosticSource, components)

		if (isComponent) {
			// componentPlaceholder 作为模块元数据交给渲染层解析；模板仍保留目标组件别名。
			// 自定义组件统一添加宿主节点，承载组件边界、属性、事件与样式隔离语义。
			content = `<component-host name="${path}">${content}</component-host>`
		}
		else {
			// 检查是否有唯一根节点，如果不是唯一根节点，则使用 <view></view> 包裹，以修复多节点导致的警告：
			// attributes (class) were passed to component but could not be automatically inherited
			const tempRoot = cheerio.load(content, {
				xmlMode: true,
				decodeEntities: false,
			})
			// 获取根级别的节点数量（不包括注释节点）
			const rootNodes = tempRoot.root().children().toArray().filter(node => node.type !== 'comment')
			// 如果根节点数量大于1，则使用 <view></view> 包裹
			if (rootNodes.length > 1) {
				content = `<view>${content}</view>`
			}
		}
	}

	const templateModule = []
	const scriptModule = []
	const $ = cheerio.load(content, {
		xmlMode: true,
		decodeEntities: false,
		_useHtmlParser2: true,
		// 减少内存占用的配置
		lowerCaseTags: false,
		lowerCaseAttributeNames: false,
		withStartIndices: true,
		withEndIndices: true,
	})

	// 处理 include 节点
	// 可以将目标文件除了 <template/> <wxs/> 外的整个代码引入，相当于是拷贝到 include 位置
	const includeNodes = $('include')
	includeNodes.each((_, elem) => {
		const src = $(elem).attr('src')
		// 将目标文件除了 <template/> <wxs/> 外的整个代码引入，相当于是拷贝到 include 位置
		if (src) {
			const includeFullPath = resolveTemplateDependencyPath(workPath, sourcePath, src)
			getDependencyGraph().addFile(path, includeFullPath, 'view')
			// 计算被包含文件的路径（去掉扩展名），用于 wxs 路径解析
			let includePath = includeFullPath.replace(workPath, '').replace(buildExtStripRegex(getTemplateExts()), '')
			const includeDiagnosticSource = includeFullPath.startsWith(workPath)
				? includeFullPath.slice(workPath.length)
				: includePath

			// 确保路径以 / 开头
			if (!includePath.startsWith('/')) {
				includePath = '/' + includePath
			}

			const includeContent = getContentByPath(includeFullPath)
			if (includeContent.trim()) {
				checkTemplateCompatibility(includeContent, includeDiagnosticSource, components)

				const $includeContent = cheerio.load(includeContent, {
					xmlMode: true,
					decodeEntities: false,
					_useHtmlParser2: true,
					withStartIndices: true,
					withEndIndices: true,
				})

				// 提取其中的 template 节点
				transTagTemplate(
					$includeContent,
					templateModule,
					includePath,
					components,
					componentPlaceholder,
					{ path: includeDiagnosticSource, content: includeContent },
					path,
				)

				// 提取其中的 wxs 节点
				transTagWxs(
					$includeContent,
					scriptModule,
					includePath,
					path,
				)

				// 处理被引入文件中的组件 wxs 依赖
				processIncludedFileWxsDependencies(includeContent, includePath, scriptModule, components, processedPaths)

				$includeContent('template').remove()
				$includeContent(getViewScriptTags().join(',')).remove()

				// 处理条件属性并替换
				const processedContent = processIncludeConditionalAttrs($, elem, $includeContent.html())
				$(elem).replaceWith(processedContent)
			} else {
				// 如果没有内容，直接移除节点
				$(elem).remove()
			}
		} else {
			// 如果没有 src 属性，直接移除节点
			$(elem).remove()
		}
	})

	// 处理 template 节点
	// https://developers.weixin.qq.com/miniprogram/dev/reference/wxml/template.html
	transTagTemplate(
		$,
		templateModule,
		sourcePath,
		components,
		componentPlaceholder,
		{ path: diagnosticSource, content: originalContent },
		path,
	)

	// 处理 wxs 节点
	// https://developers.weixin.qq.com/miniprogram/dev/reference/wxs/01wxs-module.html
	transTagWxs($, scriptModule, sourcePath, path)

	// 处理 import 节点
	// https://developers.weixin.qq.com/miniprogram/dev/reference/wxml/import.html
	const importNodes = $('import')
	importNodes.each((_, elem) => {
		const src = $(elem).attr('src')
		if (src) {
			const importFullPath = resolveTemplateDependencyPath(workPath, sourcePath, src)
			getDependencyGraph().addFile(path, importFullPath, 'view')
			let importPath = importFullPath.replace(workPath, '').replace(buildExtStripRegex(getTemplateExts()), '')
			const importDiagnosticSource = importFullPath.startsWith(workPath)
				? importFullPath.slice(workPath.length)
				: importPath

			// 确保路径以 / 开头
			if (!importPath.startsWith('/')) {
				importPath = '/' + importPath
			}

			const importContent = getContentByPath(importFullPath)
			if (importContent.trim()) {
				checkTemplateCompatibility(importContent, importDiagnosticSource, components)

				const $$ = cheerio.load(importContent, {
					xmlMode: true,
					decodeEntities: false,
					_useHtmlParser2: true,
					withStartIndices: true,
					withEndIndices: true,
				})
				// 提取其中的 template 节点
				transTagTemplate(
					$$,
					templateModule,
					importPath,
					components,
					componentPlaceholder,
					{ path: importDiagnosticSource, content: importContent },
					path,
				)

				// 提取其中的 wxs 节点
				transTagWxs(
					$$,
					scriptModule,
					importPath,
					path,
				)

				// 处理被导入文件中的组件 wxs 依赖
				processIncludedFileWxsDependencies(importContent, importPath, scriptModule, components, processedPaths)
			}
		}
	})
	importNodes.remove()

	transAsses($, $('image'), sourcePath, path)

	const res = []

	transHtmlTag($.html(), res, components, componentPlaceholder)

	return {
		tpl: res.join(''),
		sourceInfo: {
			path: diagnosticSource,
			content: originalContent,
		},
		instruction: {
			templateModule,
			scriptModule,
		},
	}
}

function transTagTemplate($, templateModule, path, components, componentPlaceholder, sourceInfo, graphOwnerPath = path) {
	const templateNodes = $('template[name]')
	templateNodes.each((_, elem) => {
		const name = $(elem).attr('name')
		const templateContent = $(elem)
		// 转化模板内代码
		templateContent.find('import').remove()
		templateContent.find('include').remove()
		templateContent.find(getViewScriptTags().join(',')).remove()
		transAsses($, templateContent.find('image'), path, graphOwnerPath)
		const res = []
		transHtmlTag(templateContent.html(), res, components, componentPlaceholder)

		templateModule.push({
			path: `tpl-${name}`,
			tpl: res.join(''),
			sourceInfo: sourceInfo
				? {
					...sourceInfo,
					startLine: getSourceLine(sourceInfo.content, elem.children?.[0]?.startIndex ?? elem.startIndex),
				}
				: null,
		})
	})
	templateNodes.remove()
}

function getSourceLine(source, index = 0) {
	return source.slice(0, Math.max(0, index)).split('\n').length
}

function transAsses($, imageNodes, path, graphOwnerPath = path) {
	imageNodes.each((_, elem) => {
		// 获取所有的图片，不支持动态引用本地资源
		const imgSrc = $(elem).attr('src').trim()
		if (!imgSrc.startsWith('{{')) {
			if (!imgSrc.startsWith('http')
				&& !imgSrc.startsWith('//')
				&& /\.(?:png|jpe?g|gif|svg)(?:\?.*)?$/.test(imgSrc)) {
				getDependencyGraph().addFile(
					graphOwnerPath,
					resolveAssetSourcePath(getWorkPath(), path, imgSrc),
					'view',
				)
			}
			$(elem).attr('src', collectAssets(getWorkPath(), path, imgSrc, getTargetPath(), getAppId()))
		}
	})
}

const DIMINA_SLOT_GROUP_TAG = 'dimina-slot-group'
const DIMINA_FOR_SCOPE_TAG = 'dimina-for-scope'

function getDirectiveAttributeNames(attrs, suffixes) {
	const directiveNames = new Set(suffixes.map(suffix => suffix.replace(/^:/, '')))
	return Object.keys(attrs || {}).filter(name => directiveNames.has(getTemplateDirectiveName(name)))
}

function hasForAndIf(attrs) {
	return getDirectiveAttributeNames(attrs, [':for', ':for-items']).length > 0
		&& getDirectiveAttributeNames(attrs, [':if']).length > 0
}

function groupDuplicateNamedSlots($, components) {
	const slotHosts = $('*').toArray().filter((element) => {
		const tag = element.tagName
		return tag === 'component' || Boolean(components?.[tag])
	})

	for (const host of slotHosts) {
		const groups = new Map()
		for (const child of $(host).children().toArray()) {
			const slotName = child.attribs?.slot
			if (!slotName) continue
			const group = groups.get(slotName) || []
			group.push(child)
			groups.set(slotName, group)
		}

		for (const [slotName, nodes] of groups) {
			// 单个普通插槽继续使用原转换，保留既有 v-if/fallback 行为。
			if (nodes.length === 1 && !hasForAndIf(nodes[0].attribs)) {
				continue
			}

			const wrapper = $(`<${DIMINA_SLOT_GROUP_TAG}></${DIMINA_SLOT_GROUP_TAG}>`)
			wrapper.attr('name', slotName)
			$(nodes[0]).before(wrapper)
			for (const node of nodes) {
				$(node).removeAttr('slot')
				wrapper.append(node)
			}
		}
	}
}

function wrapForIfScopes($) {
	const nodes = $('*').toArray()
	for (const node of nodes) {
		if (node.tagName === DIMINA_FOR_SCOPE_TAG || !hasForAndIf(node.attribs)) {
			continue
		}

		const attrsToMove = getDirectiveAttributeNames(node.attribs, [
			':for',
			':for-items',
			':for-item',
			':for-index',
			':key',
		])
		const wrapper = $(`<${DIMINA_FOR_SCOPE_TAG}></${DIMINA_FOR_SCOPE_TAG}>`)
		for (const name of attrsToMove) {
			wrapper.attr(name, node.attribs[name])
			$(node).removeAttr(name)
		}
		$(node).before(wrapper)
		wrapper.append(node)
	}
}

function normalizeTemplateSyntax(html, components) {
	const $ = cheerio.load(html, {
		xmlMode: true,
		decodeEntities: false,
		_useHtmlParser2: true,
		lowerCaseTags: false,
		lowerCaseAttributeNames: false,
	})
	groupDuplicateNamedSlots($, components)
	wrapForIfScopes($)
	return $.html()
}

function transHtmlTag(html, res, components, componentPlaceholder) {
	const attrsList = []
	const parser = new htmlparser2.Parser(
		{
			onopentag(tag, attrs) {
				attrsList.push(attrs)
				res.push(transTag({ isStart: true, tag, attrs, components, componentPlaceholder }))
			},
			ontext(text) {
				res.push(transformTextInterpolation(text))
			},
			onclosetag(tag) {
				res.push(transTag({ tag, attrs: attrsList.pop(), components }))
			},
			onerror(error) {
				console.error(error)
			},
		},
		{ xmlMode: true },
	)

	parser.write(normalizeTemplateSyntax(html, components))
	parser.end()
}

/**
 * 处理组件标签
 * @param {*} opts
 */
function transTag(opts) {
	const { isStart, tag, attrs, components } = opts
	let res
	if (tag === DIMINA_SLOT_GROUP_TAG) {
		if (isStart) {
			return `<template ${generateSlotDirective(attrs.name)}>`
		}
		return '</template>'
	}
	else if (tag === DIMINA_FOR_SCOPE_TAG) {
		res = 'template'
	}
	else if (tag === 'slot') {
		// https://cn.vuejs.org/guide/components/slots.html#slots
		// 保留插槽节点和自定义组件节点
		res = tag
	}
	else if (components && components[tag]) {
		res = `dd-${tag}`
	}
	else if (tag === 'component' || tag === 'canvas') {
		// 动态组件
		res = tag
	}
	else if (tagWhiteList.includes(tag)) {
		res = `dd-${tag}`
	}
	else {
		// glass-easel: local/global usingComponents resolution wins; an
		// undeclared tag is kept as an unused native node with its original name.
		res = tag
	}

	let tagRes
	const propsAry = isStart ? getProps(attrs, tag, components) : []
	// 多 slot 支持，目前在组件定义时的选项中 multipleSlots 未生效
	const multipleSlots = attrs?.slot
	if (attrs?.slot) {
		// 检查是否为动态插槽（slot 属性值被 {{}} 包裹）
		const isDynamicSlot = isWrappedByBraces(multipleSlots)

		if (isStart) {
			// 如果存在 if/else 属性，则需要转移到 template 中
			const withVIf = []
			const withoutVIf = []

			for (let i = 0; i < propsAry.length; i++) {
				const prop = propsAry[i]
				if (prop.includes('v-if') || prop.includes('v-else-if') || prop.includes('v-else')) {
					withVIf.push(prop)
				}
				else if(!prop.includes('slot')){
					withoutVIf.push(prop)
				}
			}
			const vIfProps = withVIf.length > 0 ? `${withVIf.join(' ')} ` : ''
			const vOtherProps = withoutVIf.length > 0 ? ` ${withoutVIf.join(' ')}` : ''

			// 构建共同的 template 内容
			const templateContent = `<template ${vIfProps}${generateSlotDirective(multipleSlots)}><${res}${vOtherProps}>`

			if (isDynamicSlot) {
				// 动态插槽无法正常编译，添加 dd-block 包装器。
				// Error: Codegen node is missing for element/if/for node. Apply appropriate transforms first.
				tagRes = `<dd-block>${templateContent}`
			} else {
				tagRes = templateContent
			}
		}
		else {
			if (isDynamicSlot) {
				tagRes = `</${res}></template></dd-block>`
			} else {
				tagRes = `</${res}></template>`
			}
		}
	}
	else {
		if (isStart) {
			const props = propsAry.join(' ')
			tagRes = props ? `<${res} ${props}>` : `<${res}>`
		}
		else {
			tagRes = `</${res}>`
		}
	}

	return tagRes
}

/**
 * 处理动态slot指令生成，比如 slot="{{xxx}}"
 *
 * @param {string} slotValue - slot属性值
 * @returns {string} 生成的slot指令
 */
function generateSlotDirective(slotValue) {
	if (isWrappedByBraces(slotValue)) {
		// 动态 slot 值，使用 v-slot 指令
		const slotExpression = parseBraceExp(slotValue)
		return `#[${slotExpression}]`
	} else {
		// 静态 slot 值，使用命名插槽语法
		return `#${slotValue}`
	}
}

/**
 * 转换语法
 * @param {*} attrs
 * @param {*} tag
 * @param {*} components - 组件映射，用于判断是否为自定义组件
 */
function getProps(attrs, tag, components) {
	const attrsList = []
	const isCustomComponent = Boolean(components && components[tag])
	// 用于记录属性绑定关系：{ 子组件属性名: 父组件数据路径 }
	const propBindings = {}
	const hasEventBindings = Object.keys(attrs).some(name => /^(?:capture-)?(?:bind|catch)(?::)?.+/.test(name))

	// New packages use vw as the rpx transport unit. Keep that contract on the
	// compiled node so PageMeta can distinguish them from legacy rem packages.
	if (tag === 'page-meta') {
		attrsList.push({
			name: 'dimina-rpx-unit',
			value: 'vw',
		})
	}

	if (hasEventBindings) {
		// exparser 的自定义事件沿 WXML 节点树派发，而 Vue 没有对应的
		// ShadowRoot/slot 路径。在真实 DOM 节点上保留事件绑定和节点类型，
		// render 层才能为 service 层重建 composed/capture 路径。
		attrsList.push({
			name: 'v-c-event-node',
			value: components && components[tag] ? "'component'" : "'node'",
		})
	}

	Object.entries(attrs).forEach(([name, value]) => {
		const templateDirective = getTemplateDirectiveName(name)
		if (templateDirective === 'if') {
			attrsList.push({
				name: 'v-if',
				value: parseSafeBraceExp(value),
			})
		}
		else if (templateDirective === 'elif') {
			attrsList.push({
				name: 'v-else-if',
				value: parseSafeBraceExp(value),
			})
		}
		else if (templateDirective === 'else') {
			attrsList.push({
				name: 'v-else',
				value: '',
			})
		}
		else if (templateDirective === 'for' || templateDirective === 'for-items') {
			attrsList.push({
				name: 'v-for',
				value: parseForExp(value, attrs),
			})
		}
		else if (templateDirective === 'for-item' || templateDirective === 'for-index') {
			// do noting
		}
		else if (templateDirective === 'key') {
			const tranValue = parseKeyExpression(value, getForItemName(attrs), getForIndexName(attrs))
			attrsList.push({
				name: ':key',
				value: tranValue,
			})
		}
		else if (name === 'style') {
			const parsedStyle = parseSafeBraceExp(value)
			// 内联样式
			attrsList.push({
				name: 'v-c-style',
				value: transformRpx(parsedStyle),
			})
			// style 是小程序自定义组件可声明的 property，同时也会作用于
			// 组件宿主。Vue 会把 style 规范化为 DOM 样式对象，因此通过内部
			// transport prop 保留原始字符串，render 层再映射回 style property。
			if (isCustomComponent) {
				attrsList.push({
					name: ':dimina-wxml-style',
					value: parsedStyle,
				})
				if (isWrappedByBraces(value) && parsedStyle) {
					propBindings.style = parsedStyle
				}
			}
		}
		else if (name === 'class') {
			if (isWrappedByBraces(value)) {
				attrsList.push({
					name: ':class',
					value: parseClassRules(value),
				})
			}
			else {
				attrsList.push({
					name: 'class',
					value,
				})
			}
			// 使用自定义指令处理可能的外部样式类 https://developers.weixin.qq.com/miniprogram/dev/framework/custom-component/wxml-wxss.html#外部样式类
			attrsList.push({
				name: 'v-c-class',
				value: '',
			})
		}
		else if (name === 'is' && tag === 'component') {
			attrsList.push({
				name: ':is',
				value: '\'dd-\'+' + `${parseSafeBraceExp(value)}`,
			})
		}
		else if (name === 'animation' && (tag !== 'movable-view' && tagWhiteList.includes(tag))) {
			// movable-view 有自己的 animation 属性
			// 自定义组件的属性有可能是 animation，所以只在普通组件节点生效
			attrsList.push({
				name: 'v-c-animation',
				value: parseSafeBraceExp(value),
			})
		}
		else if ((name === 'value' && (tag === 'input' || tag === 'textarea'))
			|| ((name === 'x' || name === 'y') && tag === 'movable-view')
		) {
			const parsedValue = parseSafeBraceExp(value)
			const conditionExp = generateVModelTemplate(parsedValue)
			if (conditionExp) {
				// v-model 不支持表达式
				attrsList.push({
					name: `:${name}`,
					value: parsedValue,
				})

				attrsList.push({
					name: `update:${name}`,
					value: conditionExp,
				})
			}
			else {
				attrsList.push({
					name: `v-model:${name}`,
					value: parsedValue,
				})
			}
		}
		else if (name.startsWith('data-')) {
			if (isWrappedByBraces(value)) {
				attrsList.push({
					name: 'v-c-data',
					value: '',
				})

				attrsList.push({
					name: `:${name}`,
					value: parseSafeBraceExp(value),
				})
			}
			else {
				attrsList.push({
					name,
					value,
				})
			}
		}
		else if (isWrappedByBraces(value)) {
			const pVal = tag === 'template' && name === 'data'
				? parseTemplateDataExp(value)
				: parseSafeBraceExp(value)

			// 如果是自定义组件的属性绑定，记录绑定关系
			if (isCustomComponent) {
				// 记录：子组件属性名 -> 父组件数据表达式
				// 例如：count2="{{count}}" => propBindings['count2'] = 'count'
				//       value="{{item.name}}" => propBindings['value'] = 'item.name'
				//       total="{{count + defaultValue}}" => propBindings['total'] = 'count + defaultValue'
				// 确保 pVal 是有效的字符串值
				if (pVal && typeof pVal === 'string') {
					propBindings[name] = pVal
				}
			}

			// 转换 {{}}，绑定属性
			attrsList.push({
				name: `:${name}`,
				value: pVal,
			})
		}
		else if (name !== 'slot') {
			attrsList.push({
				name,
				value,
			})
		}
	})

	const propsRes = []
	attrsList.forEach((attr) => {
		const { name, value } = attr
		if (value === '') {
			propsRes.push(`${name}`)
		}
		else if (/\$\{[^}]*\}/.test(value)) {
			// 内容中含有 ${...} 为模板字符串
			propsRes.push(`:${name}="\`${value}\`"`)
		}
		else {
			// 统一转义属性值，避免生成的 Vue 模板被值中的引号截断。
			propsRes.push(`${name}="${escapeQuotes(value)}"`)
		}
	})

	// 如果是自定义组件且有属性绑定，添加绑定信息
	if (isCustomComponent && Object.keys(propBindings).length > 0) {
		// 解析绑定表达式，提取依赖信息
		try {
			// 过滤掉无效值，确保所有值都是可序列化的字符串
			const validBindings = {}
			for (const [key, value] of Object.entries(propBindings)) {
				if (value !== undefined && value !== null && typeof value === 'string') {
					validBindings[key] = value
				}
			}

		if (Object.keys(validBindings).length > 0) {
			// 解析表达式，生成包含依赖信息的绑定对象
			const parsedBindings = parseBindings(validBindings)
			// 使用动态绑定 + HTML 实体转义，Vue 会自动解码并解析为对象
			const bindingsJson = JSON.stringify(parsedBindings)
			const escapedJson = bindingsJson.replace(/"/g, '&quot;')
			propsRes.push(`v-c-prop-bindings="${escapedJson}"`)
		}
		} catch (error) {
			console.warn('[compiler] 序列化 propBindings 失败:', error.message, '标签:', tag, '绑定数据:', propBindings)
		}
	}

	return propsRes
}

function generateVModelTemplate(expression) {
	let var1, var2, updateExpression

	if (expression.includes('&&')) {
		// 处理 "x && y"
		[var1, var2] = expression.split('&&').map(v => v.trim())
		// 对于 x && y，x 为真时更新 y，x 为假时更新 x
		updateExpression = `${var1} ? (${var2} = $event) : (${var1} = $event)`
	}
	else if (expression.includes('||')) {
		// 处理 "x || y"
		[var1, var2] = expression.split('||').map(v => v.trim())
		// 对于 x || y，x 为真时更新 x，x 为假时更新 y
		updateExpression = `${var1} ? (${var1} = $event) : (${var2} = $event)`
	}
	else if (expression.includes('?')) {
		// 处理 "x ? x : y"
		const parts = expression.split(/[?:]/).map(v => v.trim())
		var1 = parts[0]
		var2 = parts[2]
		// 对于 x ? x : y，x 为真时更新 x，x 为假时更新 y
		updateExpression = `${var1} ? (${var1} = $event) : (${var2} = $event)`
	}
	else {
		return false
	}
	return updateExpression
}

/**
 * 兼容 :key="{{ index }}" 或 :key="{{ item.index }}"的情况
 */
function parseKeyExpression(exp, itemName = 'item', indexName = 'index') {
	// 去除首尾空格
	exp = exp.trim()

	// https://developers.weixin.qq.com/miniprogram/dev/reference/wxml/list.html#wx:key
	// 保留关键字 *this 代表在 for 循环中的 item 本身，这种表示需要 item 本身是一个唯一的字符串或者数字
	if (/\*this/.test(exp) || /\*item/.test(exp)) {
		return `${itemName}.toString()`
	}

	// 处理简单无表达式的情况
	if (!exp.includes('{{')) {
		// 检查是否为纯数字（包括负数）
		if (/^-?\d+(\.\d+)?$/.test(exp)) {
			return exp
		}
		// 特殊处理索引变量名 - 直接返回索引变量名，不添加 item 前缀
		if (exp === indexName) {
			return indexName
		}
		return exp.startsWith(itemName) ? `${exp}` : `${itemName}.${exp}`
	}

	// 处理 '{{xxx}}' 的情况
	if (exp.startsWith('{{') && exp.endsWith('}}')) {
		const content = exp.slice(2, -2).trim()
		if (content === 'this') {
			return `${itemName}.toString()`
		} else if (content === indexName) {
			// 特殊处理索引变量名 - 直接返回索引变量名
			return indexName
		} else {
			return content.startsWith(itemName) ? `${content}` : `${itemName}.${content}`
		}
	}

	// 处理 '1-{{xxx}}' 的情况
	const parts = exp.split(/(\{\{.*?\}\})/)
	const result = parts.map((part) => {
		if (part.startsWith('{{') && part.endsWith('}}')) {
			const content = part.slice(2, -2).trim()
			if (content === indexName) {
				return indexName
			}
			return content.startsWith(itemName) ? content : `${itemName}.${content}`
		}
		return `'${part}'`
	}).join('+')

	// 移除结果末尾的 +''（如果存在）
	return result.endsWith('+\'\'') ? result.slice(0, -3) : result
}

/**
 * 根据工作目录获取 ml 文件绝对路径
 * @param {string} workPath
 * @param {string} src
 * @returns 返回绝对路径
 */
function getViewPath(workPath, src) {
	const aSrc = src.startsWith('/') ? src : `/${src}`
	for (const mlType of getTemplateExts()) {
		const mlFullPath = `${workPath}${aSrc}${mlType}`
		if (fs.existsSync(mlFullPath)) {
			return mlFullPath
		}

		const indexMlFullPath = `${workPath}${aSrc}/index${mlType}`
		if (fs.existsSync(indexMlFullPath)) {
			return indexMlFullPath
		}
	}
}

/**
 * 解析 import/include 的模板文件路径。
 * 微信允许省略 .wxml；显式扩展名保持原样，无扩展名时按当前模板类型优先级补全。
 */
function resolveTemplateDependencyPath(workPath, ownerPath, src) {
	const resolvedPath = getAbsolutePath(workPath, ownerPath, src)
	if (fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isFile()) {
		return resolvedPath
	}

	if (path.extname(resolvedPath)) {
		return resolvedPath
	}

	for (const ext of getTemplateExts()) {
		const candidate = `${resolvedPath}${ext}`
		if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
			return candidate
		}
	}

	return resolvedPath
}

/**
 * 将字符串内部的双引号进行替换
 * @param {*} input
 */
function escapeQuotes(input) {
	return input.replace(/"/g, '\'')
}

/**
 * 判断字符串是不是被{{}}包裹
 * @param {*} str
 */
function isWrappedByBraces(str) {
	return /\{\{.*\}\}/.test(str)
}

function splitWithBraces(str) {
	const result = []
	let temp = ''
	let inBraces = false

	for (let i = 0; i < str.length; i++) {
		const char = str[i]

		// 如果遇到左大括号'{{'，进入大括号模式
		if (char === '{' && i + 1 < str.length && str[i + 1] === '{') {
			inBraces = true
			temp += '{{' // 添加'{{'到temp
			i++ // 跳过下一个字符（即另一个'{'）
		}
		// 如果遇到右大括号'}}'，退出大括号模式
		else if (char === '}' && i + 1 < str.length && str[i + 1] === '}') {
			inBraces = false
			temp += '}}' // 添加'}}'到temp
			i++ // 跳过下一个字符（即另一个'}'）
		}
		// 如果不在大括号内且遇到空格，则当前temp是一个分割部分
		else if (!inBraces && char === ' ') {
			if (temp) {
				result.push(temp)
				temp = '' // 重置temp以开始新的单词
			}
		}
		// 否则，将字符添加到temp
		else {
			temp += char
		}
	}

	// 如果temp还有剩余内容（即最后一个单词或在大括号内的内容），则将其添加到结果中
	if (temp) {
		result.push(temp)
	}

	return result
}

function parseClassRules(cssRule) {
	let list = splitWithBraces(cssRule)
	list = list.map((item) => {
		return parseSafeBraceExp(item)
	})

	if (list.length === 1) {
		return list.pop()
	}
	return `[${list.join(',')}]`
}

/**
 * https://developers.weixin.qq.com/miniprogram/dev/reference/wxml/list.html#wx-for
 * 使用 :for-item 可以指定数组当前元素的变量名
 * @param {*} attrs
 */
function getForItemName(attrs) {
	for (const key in attrs) {
		if (getTemplateDirectiveName(key) === 'for-item') {
			return attrs[key]
		}
	}
	return 'item'
}

/**
 * 使用 :for-index 可以指定数组当前下标的变量名
 * @param {*} attrs
 */
function getForIndexName(attrs) {
	for (const key in attrs) {
		if (getTemplateDirectiveName(key) === 'for-index') {
			return attrs[key]
		}
	}
	return 'index'
}

/**
 * 解析 for 表达式的值
 * @param {*} exp
 * @param {*} attrs
 */
function parseForExp(exp, attrs) {
	const item = getForItemName(attrs)
	const index = getForIndexName(attrs)
	const listVariableName = parseSafeBraceExp(exp)
	return `(${item}, ${index}) in ${listVariableName}`
}

// 使用正则表达式匹配{{}}内的内容，并放入第一个分组
// 使用正则表达式匹配非{{}}内的内容，并放入第二个分组
// 使用全局标志g，表示匹配所有符合条件的部分
const braceRegex = /(\{\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\}\})|([^{}]+)/g
const noBraceRegex = /\{\{((?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*)\}\}/
const ternaryRegex = /[^?]+\?.+:.+/
const RESERVED_TEMPLATE_CONTEXT_ALIASES = new Map([
	['class', '__dimina_reserved_class'],
])
const RESERVED_TEMPLATE_CONTEXT_NAMES = new Map(
	[...RESERVED_TEMPLATE_CONTEXT_ALIASES].map(([name, alias]) => [alias, name]),
)

function encodeReservedTemplateContextIdentifier(expression) {
	return RESERVED_TEMPLATE_CONTEXT_ALIASES.get(expression) || expression
}

/**
 * 解析 {{}} 表达式的值
 * @param {*} exp
 */
function parseBraceExp(exp) {
	// 定义两个数组，分别存放两个分组的匹配结果
	// 使用exec方法，循环执行正则表达式，直到返回null为止
	let result
	const group = []
	// eslint-disable-next-line no-cond-assign
	while ((result = braceRegex.exec(exp))) {
		// 如果第一个分组有匹配结果，移除 {{}}
		if (result[1]) {
			const matchResult = result[1].match(noBraceRegex)

			if (matchResult) {
				const statement = encodeReservedTemplateContextIdentifier(matchResult[1].trim())
				if (ternaryRegex.test(statement)) {
					// 三目表达式用 () 包裹，防止影响优先级
					group.push(`(${statement})`)
				}
				else {
					group.push(statement)
				}
			}
		}
		// 如果第二个分组有匹配结果，内联字符串拼接
		if (result[2]) {
			group.push(`+'${result[2].replace(/'/g, '\\\'')}'+`)
		}
	}
	// 去掉字符串首尾的加号，返回转换后的字符串
	return group.join('').replace(/^\+|\+$/g, '')
}

/**
 * 解析 template 的 data 对象表达式，保留对象字面量和内部三元表达式
 * @param {string} exp
 * @returns {string} 解析后的对象表达式字符串
 */
function parseTemplateDataExp(exp) {
	const matchResult = exp.trim().match(/^\{\{([\s\S]*)\}\}$/)
	if (matchResult) {
		return addOptionalChaining(`{${matchResult[1].trim()}}`)
	}
	return `{${parseSafeBraceExp(exp)}}`
}

function transTagWxs($, scriptModule, filePath, graphOwnerPath = filePath) {
	// 同时处理所有视图脚本标签（wxs、dds 及自定义标签），避免同一文件混用多种标签时漏编译。
	const wxsNodes = $(getViewScriptTags().join(','))

	wxsNodes.each((_, elem) => {
		const smName = $(elem).attr('module')

		if (smName) {
			let wxsContent
			let uniqueModuleName = smName
			let cacheKey = smName

			const src = $(elem).attr('src')
			let wxsFilePath = null
			const workPath = getWorkPath()

			if (src) {
				// 检查是否是 npm 组件路径
				if (filePath.includes('/miniprogram_npm/')) {
					// 对于 npm 组件，需要特殊处理相对路径
					// filePath 格式: /miniprogram_npm/@vant/weapp/radio-group/index
					// src 格式: ../wxs/utils.wxs 或 ./index.wxs

					// 获取组件所在目录的完整路径
					const componentDir = filePath.split('/').slice(0, -1).join('/')
					const componentFullPath = workPath + componentDir

					// 使用 Node.js path.resolve 来正确解析相对路径
					wxsFilePath = path.resolve(componentFullPath, src)
				} else {
					// 对于普通组件，使用原有逻辑
					wxsFilePath = getAbsolutePath(workPath, filePath, src)
				}

				if (wxsFilePath) {
					getDependencyGraph().addFile(graphOwnerPath, wxsFilePath, 'view')
					// 为外部 wxs 文件生成唯一的模块名和缓存键
					const relativePath = stripViewScriptExt(wxsFilePath.replace(workPath, ''))
					uniqueModuleName = relativePath.replace(/[\/\\@\-]/g, '_').replace(/^_/, '')
					cacheKey = wxsFilePath // 使用文件路径作为缓存键确保唯一性
				}
			}

			if (compileResCache.has(cacheKey)) {
				wxsContent = compileResCache.get(cacheKey)
			}
			else {
				if (src && wxsFilePath) {
					if (fs.existsSync(wxsFilePath)) {
						wxsContent = getContentByPath(wxsFilePath).trim()
					} else {
						console.warn(`[view] wxs 文件不存在: ${wxsFilePath}`)
						return
					}
				}
				else {
					wxsContent = $(elem).html()
				}

				if (!wxsContent) {
					return
				}

				// 使用公共的处理函数
				wxsContent = processWxsContent(wxsContent, wxsFilePath, scriptModule, workPath, filePath, graphOwnerPath)

				compileResCache.set(cacheKey, wxsContent)
			}
			if (wxsContent) {
				// 注册为 wxs 模块（因为这是从 wxs 节点加载的，一定是 wxs 脚本）
				registerWxsModule(uniqueModuleName)

				scriptModule.push({
					path: uniqueModuleName,
					code: wxsContent,
					originalName: smName, // 保存原始模块名用于模板中的引用
				})
			}
		}
	})
	wxsNodes.remove()
}

/**
 * 递归收集 wxs 模块的所有依赖
 * @param {Map} scriptRes - 脚本资源映射
 * @param {Set} collectedPaths - 已收集的路径集合，避免重复处理
 * @param {Array} scriptModule - 用于收集新加载的 wxs 模块
 * @returns {Array} 所有 wxs 模块的数组
 */
function collectAllWxsModules(scriptRes, collectedPaths = new Set(), scriptModule = []) {
	const allWxsModules = []
	const workPath = getWorkPath()

	for (const [modulePath, moduleCode] of scriptRes.entries()) {
		// 避免重复处理
		if (collectedPaths.has(modulePath)) {
			continue
		}

		// 检查是否是 wxs 模块
		if (isWxsModuleByContent(moduleCode, modulePath)) {
			collectedPaths.add(modulePath)
			allWxsModules.push({
				path: modulePath,
				code: moduleCode
			})

			// 递归收集该模块的依赖
			const dependencies = extractWxsDependencies(moduleCode)
			for (const depPath of dependencies) {
				if (!collectedPaths.has(depPath)) {
					if (scriptRes.has(depPath)) {
						// 如果依赖已经在 scriptRes 中，递归处理
						const depModules = collectAllWxsModules(new Map([[depPath, scriptRes.get(depPath)]]), collectedPaths, scriptModule)
						allWxsModules.push(...depModules)
					} else {
						// 如果依赖不在 scriptRes 中，尝试从文件系统加载
						const loaded = loadWxsModule(depPath, workPath, scriptModule)
						if (loaded) {
							// 将加载的模块添加到 scriptRes 中
							scriptRes.set(depPath, loaded.code)
							allWxsModules.push(loaded)
							collectedPaths.add(depPath)

							// 递归处理新加载模块的依赖
							const depModules = collectAllWxsModules(new Map([[depPath, loaded.code]]), collectedPaths, scriptModule)
							allWxsModules.push(...depModules)
						}
					}
				}
			}
		}
	}

	return allWxsModules
}

/**
 * 尝试从文件系统加载 wxs 模块
 * @param {string} modulePath - 模块路径
 * @param {string} workPath - 工作路径
 * @param {Array} scriptModule - 脚本模块数组
 * @returns {Object|null} 加载的模块对象或 null
 */
function loadWxsModule(modulePath, workPath, scriptModule) {
	// wxsFilePathMap 记录 miniprogram_npm 下使用任意已配置扩展名的视图脚本文件，
	// 用于判断并定位模块。不能依赖 '_wxs_' 路径片段，否则会漏掉自定义扩展名
	// （如 .qds），以及路径中不含 wxs 目录的 .wxs 文件。
	const wxsFilePath = wxsFilePathMap.get(modulePath)

	if (!wxsFilePath) {
		return null
	}

	try {
		const wxsContent = getContentByPath(wxsFilePath).trim()
		if (!wxsContent) {
			return null
		}

		// 使用公共的处理函数
		const processedContent = processWxsContent(wxsContent, wxsFilePath, scriptModule, workPath, '')

		// 注册为 wxs 模块
		registerWxsModule(modulePath)

		return {
			path: modulePath,
			code: processedContent
		}
	} catch (error) {
		console.warn(`[view] 加载 wxs 模块失败: ${modulePath}`, error.message)
		return null
	}
}

/**
 * 从 wxs 模块代码中提取依赖的模块路径
 * @param {string} moduleCode - 模块代码
 * @returns {Array} 依赖的模块路径数组
 */
function extractWxsDependencies(moduleCode) {
	const dependencies = []

	// 匹配 require("模块路径") 或 _("模块路径") 调用
	const requirePattern = /(?:require|_)\s*\(\s*["']([^"']+)["']\s*\)/g
	let match

	// eslint-disable-next-line no-cond-assign
	while ((match = requirePattern.exec(moduleCode)) !== null) {
		const depPath = match[1]
		if (depPath && !dependencies.includes(depPath)) {
			dependencies.push(depPath)
		}
	}

	return dependencies
}

function insertWxsToRenderResult(code, scriptModule, scriptRes, filename = 'render.js', inputMap = null) {
	const wxsBindings = []
	const codeReplacements = []
	const ast = parseJs(code, filename)
	const statement = ast.body?.[0]
	const renderExpression = statement?.type === 'ExpressionStatement' ? statement.expression : null
	const renderBody = renderExpression?.body
	const declarations = []

	for (const [index, sm] of scriptModule.entries()) {
		if (!scriptRes.has(sm.path)) {
			scriptRes.set(sm.path, sm.code)
		}

		// 使用原始模块名作为模板中的属性名，唯一模块名作为 require 的参数
		const templatePropertyName = sm.originalName || sm.path
		const requireModuleName = sm.path
		const localIdentifier = `__wxs_${index}`

		wxsBindings.push({
			localIdentifier,
			templatePropertyName,
		})

		declarations.push(`const ${localIdentifier} = require(${JSON.stringify(requireModuleName)});`)
	}

	if (wxsBindings.length > 0 && renderBody?.type === 'BlockStatement') {
		codeReplacements.push({
			type: 'insert',
			start: renderBody.start + 1,
			end: renderBody.start + 1,
			value: `\n${declarations.join('\n')}`,
		})
	}

	walk(ast, {
		enter(node) {
			if (
				node.type === 'MemberExpression'
				&&
				node.object?.type === 'Identifier'
				&& node.object.name === '_ctx'
				&& !node.computed
				&& node.property?.type === 'Identifier'
			) {
				const reservedName = RESERVED_TEMPLATE_CONTEXT_NAMES.get(node.property.name)
				if (reservedName) {
					codeReplacements.push({
						start: node.property.start,
						end: node.property.end,
						value: reservedName,
					})
					return
				}

				const replacement = wxsBindings.find(item => item.templatePropertyName === node.property.name)
				if (replacement) {
					codeReplacements.push({
						start: node.start,
						end: node.end,
						value: replacement.localIdentifier,
					})
				}
			}
		},
	})
	if (codeReplacements.length === 0) {
		return { code: getProgramCode(code, ast), map: inputMap }
	}

	const transformed = applyCodeReplacements(code, codeReplacements)
	let map = inputMap
	if (enableSourcemap) {
		const generatedMap = new MagicString(code)
		const selected = []
		for (const replacement of [...codeReplacements].sort((a, b) => (b.end - b.start) - (a.end - a.start))) {
			if (!selected.some(item => replacement.start < item.end && item.start < replacement.end)) {
				selected.push(replacement)
			}
		}
		for (const replacement of selected.sort((a, b) => b.start - a.start)) {
			if (replacement.type === 'insert') {
				generatedMap.appendLeft(replacement.start, replacement.value)
			}
			else {
				generatedMap.overwrite(replacement.start, replacement.end, replacement.value)
			}
		}
		const wxsTransformMap = generatedMap.generateMap({
			file: filename,
			source: filename,
			includeContent: true,
			hires: true,
		}).toString()
		map = inputMap ? remapSourcemap(wxsTransformMap, inputMap) : wxsTransformMap
	}
	const transformedAst = parseJs(transformed, filename)
	return { code: getProgramCode(transformed, transformedAst), map }
}

export {
	compileML,
	generateVModelTemplate,
	generateSlotDirective,
	initWxsFilePathMap,
	loadWxsModule,
	parseBraceExp,
	parseClassRules,
	parseKeyExpression,
	parseTemplateDataExp,
	normalizeTemplateSyntax,
	processIncludeConditionalAttrs,
	processWxsContent,
	splitWithBraces,
}
