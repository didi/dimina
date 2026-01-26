import fs from 'node:fs'
import path from 'node:path'
import { isMainThread, parentPort } from 'node:worker_threads'
import babel from '@babel/core'
import _traverse from '@babel/traverse'
import types from '@babel/types'
import generate from '@babel/generator'
import { compileTemplate } from '@vue/compiler-sfc'
import * as cheerio from 'cheerio'
import { transform } from 'esbuild'
import * as htmlparser2 from 'htmlparser2'
import { collectAssets, getAbsolutePath, tagWhiteList, transformRpx } from '../common/utils.js'
import { getAppId, getComponent, getContentByPath, getTargetPath, getWorkPath, resetStoreInfo } from '../env.js'
import { parseBindings } from '../common/expression-parser.js'

// https://github.com/babel/babel/issues/13855
const traverse = _traverse.default ? _traverse.default : _traverse
const generateCode = generate.default ? generate.default : generate

const fileType = ['.wxml', '.ddml']

/**
 * 从 AST 生成代码，如果顶层是单个表达式语句，则只生成表达式部分
 * @param {*} ast - Babel AST
 * @returns {string} 生成的表达式代码
 */
function generateCodeFromAst(ast) {
	// 检查是否是 Program 节点且只包含一个 ExpressionStatement
	if (ast.type === 'File' && ast.program.body.length === 1) {
		const statement = ast.program.body[0]
		if (statement.type === 'ExpressionStatement') {
			return generateCode(statement.expression, { comments: false }).code
		}
	}
	return generateCode(ast, { comments: false }).code
}

// 页面文件编译内容缓存
const compileResCache = new Map()

// wxs 模块注册表，用于记录确定的 wxs 模块
const wxsModuleRegistry = new Set()

// wxs 文件路径映射表，用于快速查找模块对应的文件路径
const wxsFilePathMap = new Map()

if (!isMainThread) {
	parentPort.on('message', async ({ pages, storeInfo }) => {
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

			await compileML(pages.mainPages, null, progress)

			for (const [root, subPages] of Object.entries(pages.subPages)) {
				await compileML(subPages.info, root, progress)
			}

			// Worker 任务完成后清理所有缓存，释放内存
			compileResCache.clear()
			wxsModuleRegistry.clear()
			wxsFilePathMap.clear()

			parentPort.postMessage({ success: true })
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
		buildCompileView(page, false, scriptRes, [])

		let mergeRender = ''

		for (const [key, value] of scriptRes.entries()) {
			const amdFormat = `modDefine('${key}', function(require, module, exports) {
		${value}
		});`
			const { code: minifiedCode } = await transform(amdFormat, {
				minify: true,
				target: ['es2020'],
				platform: 'browser',
			})
			mergeRender += minifiedCode
		}
		
		// 单个页面编译完成后清理 scriptRes，释放内存
		scriptRes.clear()

		const filename = `${page.path.replace(/\//g, '_')}`

		if (root) {
			const subDir = `${getTargetPath()}/${root}`
			if (!fs.existsSync(subDir)) {
				fs.mkdirSync(subDir, { recursive: true })
			}
			fs.writeFileSync(`${subDir}/${filename}.js`, mergeRender)
		}
		else {
			const mainDir = `${getTargetPath()}/main`
			if (!fs.existsSync(mainDir)) {
				fs.mkdirSync(mainDir, { recursive: true })
			}
			fs.writeFileSync(`${mainDir}/${filename}.js`, mergeRender)
		}

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
			} else if (stat.isFile() && item.endsWith('.wxs')) {
				// 处理 wxs 文件
				const relativePath = fullPath.replace(workPath, '').replace(/\.wxs$/, '')
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

/**
 * 检查是否为已注册的 wxs 模块
 * @param {string} modulePath - 模块路径
 * @returns {boolean} wxs 模块是否已注册
 */
function isRegisteredWxsModule(modulePath) {
	return wxsModuleRegistry.has(modulePath)
}

function buildCompileView(module, isComponent = false, scriptRes, depthChain = []) {
	const currentPath = module.path

	// Circular dependency detected
	if (depthChain.includes(currentPath)) {
		console.warn('[view]', `检测到循环依赖: ${[...depthChain, currentPath].join(' -> ')}`)
		return
	}
	// Deep dependency chain detected
	if (depthChain.length > 20) {
		console.warn('[view]', `检测到深度依赖: ${[...depthChain, currentPath].join(' -> ')}`)
		return
	}
	depthChain = [...depthChain, currentPath]
	
	// 收集所有 wxs 模块（包括组件的）
	const allScriptModules = []
	
	// 首先编译当前模块
	const currentInstruction = compileModule(module, isComponent, scriptRes)
	if (currentInstruction && currentInstruction.scriptModule) {
		allScriptModules.push(...currentInstruction.scriptModule)
	}

	if (module.usingComponents) {
		for (const componentInfo of Object.values(module.usingComponents)) {
			const componentModule = getComponent(componentInfo)
			if (!componentModule) {
				continue
			}
			// 检查自依赖：如果组件依赖自己，则跳过
			if (componentModule.path === module.path) {
				console.warn('[view]', `检测到循环依赖，跳过处理: ${module.path}`)
				continue
			}
			
			// 递归编译组件，并收集其 wxs 模块
			const componentInstruction = buildCompileView(componentModule, true, scriptRes, depthChain)
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
		compileModuleWithAllWxs(module, scriptRes, allScriptModules)
	}
	
	// 返回当前模块的指令信息（包含 wxs 模块）
	return { scriptModule: allScriptModules }
}

/**
 * 编译页面及自定义组件，自定义组件可认为是特殊的页面
 * https://developers.weixin.qq.com/miniprogram/dev/framework/custom-component/
 * @param {*} module
 */
function compileModule(module, isComponent, scriptRes) {
	const { tpl, instruction } = toCompileTemplate(isComponent, module.path, module.usingComponents, module.componentPlaceholder)
	if (!tpl) {
		return null
	}

	// 检查是否有缓存的模板编译结果
	let useCache = false
	let cachedCode = null
	
	if (!scriptRes.has(module.path) && compileResCache.has(module.path)) {
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
		compilerOptions: {
			// https://template-explorer.vuejs.org/
			prefixIdentifiers: true,
			hoistStatic: false,
			cacheHandlers: true,
			scopeId: `data-v-${module.id}`,
			mode: 'function',
			inline: true,
		},
	})

	let tplComponents = '{'
	for (const tm of instruction.templateModule) {
		let { code } = compileTemplate({
			source: tm.tpl,
			filename: tm.path,
			id: `data-v-${module.id}`,
			scoped: true,
			compilerOptions: {
				prefixIdentifiers: true,
				hoistStatic: false,
				cacheHandlers: true,
				scopeId: `data-v-${module.id}`,
				mode: 'function',
				inline: true,
			},
		})

		const ast = babel.parseSync(code)
		insertWxsToRenderAst(ast, instruction.scriptModule, scriptRes)
		code = generateCodeFromAst(ast)

		tplComponents
			+= `'${tm.path}':${code},`
	}
	tplComponents += '}'

	const tplAst = babel.parseSync(tplCode.code)
	insertWxsToRenderAst(tplAst, instruction.scriptModule, scriptRes)
	const transCode = generateCodeFromAst(tplAst)

	// 通过 component 字段标记该页面 以 Component 形式进行渲染或着以 Page 形式进行渲染
	// https://developers.weixin.qq.com/miniprogram/dev/framework/app-service/page.html
	// https://developers.weixin.qq.com/miniprogram/dev/framework/custom-component/component.html
	const code = `Module({
		path: '${module.path}',
		id: '${module.id}',
		render: ${transCode},
		usingComponents: ${JSON.stringify(module.usingComponents)},
		tplComponents: ${tplComponents},
		});`

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

	// 缓存编译结果，包含代码和更新后的指令信息
	const cacheData = {
		code: code,
		instruction: instruction
	}
	compileResCache.set(module.path, cacheData)
	scriptRes.set(module.path, code)
	
	return instruction
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
function processWxsContent(wxsContent, wxsFilePath, scriptModule, workPath, filePath) {
	
	let wxsAst
	try {
		wxsAst = babel.parseSync(wxsContent)
	} catch (error) {
		console.error(`[view] 解析 wxs 文件失败: ${wxsFilePath}`, error.message)
		return wxsContent // 返回原始内容
	}
	
	// 遍历并处理各种转换
	traverse(wxsAst, {
		CallExpression(astPath) {
			const calleeName = astPath.node.callee.name
			
			// https://developers.weixin.qq.com/miniprogram/dev/reference/wxs/06datatype.html#regexp
			// getRegExp -> 正则表达式字面量或 new RegExp 调用
			if (calleeName === 'getRegExp') {
				const args = astPath.node.arguments
				
				if (args.length > 0) {
					// 如果参数都是字符串字面量，直接转换为正则表达式字面量
					if (args[0].type === 'StringLiteral' && (!args[1] || args[1].type === 'StringLiteral')) {
						// 获取正则表达式的模式和标志
						let pattern = ''
						let flags = ''
						
						// 第一个参数是模式（字符串字面量）
						const arg = args[0]
						
						// 获取字符串的原始值，保留其中的转义字符
						if (arg.extra && arg.extra.raw) {
							// 去掉首尾的引号，但保留内部的转义字符
							pattern = arg.extra.raw.slice(1, -1)
						} else if (arg.value !== undefined) {
							pattern = arg.value
						} else {
							pattern = ''
						}
						
						if (args.length > 1) {
							// 第二个参数是标志（字符串字面量）
							const flagArg = args[1]
							
							if (flagArg.extra && flagArg.extra.raw) {
								flags = flagArg.extra.raw.slice(1, -1)
							} else if (flagArg.value !== undefined) {
								flags = flagArg.value
							} else {
								flags = ''
							}
						}
						
						// 直接创建正则表达式字面量，将 getRegExp("pattern", "flags") 转换为 /pattern/flags
						const regexLiteral = types.regExpLiteral(pattern, flags)
						
						// 直接替换为正则表达式字面量
						astPath.replaceWith(regexLiteral)
					} else {
						// 对于变量参数，转换为 new RegExp(pattern, flags) 调用
						const newRegExpArgs = [args[0]]
						if (args.length > 1) {
							newRegExpArgs.push(args[1])
						}
						
						const newRegExpCall = types.newExpression(
							types.identifier('RegExp'),
							newRegExpArgs
						)
						
						// 替换为 new RegExp 调用
						astPath.replaceWith(newRegExpCall)
					}
				}
			}
			else if (calleeName === 'getDate') {
				// getDate -> new Date
				const args = []
				for (let i = 0; i < astPath.node.arguments.length; i++) {
					args.push(astPath.node.arguments[i])
				}
				// 创建新的 NewExpression 节点
				const newExpr = types.newExpression(types.identifier('Date'), args)
				// 替换原来的 CallExpression 节点
				astPath.replaceWith(newExpr)
			}
			// 处理 wxs 文件内部的 require 调用（仅对外部文件）
			else if (calleeName === 'require' && astPath.node.arguments.length > 0 && wxsFilePath) {
				const requirePath = astPath.node.arguments[0].value
				
				if (requirePath && typeof requirePath === 'string') {
					// 解析 wxs 内部的相对路径 require
					let resolvedWxsPath
					
					if (filePath && filePath.includes('/miniprogram_npm/')) {
						// 对于 npm 组件中的 wxs，需要特殊处理相对路径
						const currentWxsDir = path.dirname(wxsFilePath)
						resolvedWxsPath = path.resolve(currentWxsDir, requirePath)
						
						// 转换为相对于工作目录的路径，并移除 .wxs 扩展名
						const relativePath = resolvedWxsPath.replace(workPath, '').replace(/\.wxs$/, '')
						
						// 生成唯一的模块名（移除特殊字符）
						const moduleName = relativePath.replace(/[\/\\@\-]/g, '_').replace(/^_/, '')
						
						// 递归处理依赖的 wxs 文件
						processWxsDependency(resolvedWxsPath, moduleName, scriptModule, workPath, filePath)
						
						// 替换 require 路径
						astPath.node.arguments[0] = types.stringLiteral(moduleName)
					} else {
						// 对于普通组件，使用原有逻辑
						const currentWxsDir = path.dirname(wxsFilePath)
						resolvedWxsPath = path.resolve(currentWxsDir, requirePath)
						const relativePath = resolvedWxsPath.replace(workPath, '').replace(/\.wxs$/, '')
						const depModuleName = relativePath.replace(/[\/\\@\-]/g, '_').replace(/^_/, '')
						
						// 递归处理依赖
						processWxsDependency(resolvedWxsPath, depModuleName, scriptModule, workPath, filePath)
						
						// 替换 require 路径
						astPath.node.arguments[0] = types.stringLiteral(depModuleName)
					}
				}
			}
		},
		MemberExpression(astPath) {
			// 处理 constructor 属性访问，模拟微信小程序 wxs 中 constructor 返回字符串的行为
			if (astPath.node.property.name === 'constructor' && !astPath.node.computed) {
				// 创建一个辅助函数调用，返回类型字符串
				// 生成: Object.prototype.toString.call(obj).slice(8, -1)
				const getTypeString = types.callExpression(
					types.memberExpression(
						types.callExpression(
							types.memberExpression(
								types.memberExpression(
									types.memberExpression(
										types.identifier('Object'),
										types.identifier('prototype')
									),
									types.identifier('toString')
								),
								types.identifier('call')
							),
							[astPath.node.object]
						),
						types.identifier('slice')
					),
					[types.numericLiteral(8), types.numericLiteral(-1)]
				)
				
				astPath.replaceWith(getTypeString)
			}
		},
	})
	
	// 生成代码
	return generateCodeFromAst(wxsAst)
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
function processWxsDependency(wxsFilePath, moduleName, scriptModule, workPath, filePath) {
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
	const wxsCode = processWxsContent(wxsContent, wxsFilePath, scriptModule, workPath, filePath)
	
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
function compileModuleWithAllWxs(module, scriptRes, allScriptModules) {
	const { tpl, instruction } = toCompileTemplate(false, module.path, module.usingComponents, module.componentPlaceholder)
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
		compilerOptions: {
			prefixIdentifiers: true,
			hoistStatic: false,
			cacheHandlers: true,
			scopeId: `data-v-${module.id}`,
			mode: 'function',
			inline: true,
		},
	})

	let tplComponents = '{'
	for (const tm of mergedInstruction.templateModule) {
		let { code } = compileTemplate({
			source: tm.tpl,
			filename: tm.path,
			id: `data-v-${module.id}`,
			scoped: true,
			compilerOptions: {
				prefixIdentifiers: true,
				hoistStatic: false,
				cacheHandlers: true,
				scopeId: `data-v-${module.id}`,
				mode: 'function',
				inline: true,
			},
		})

		const ast = babel.parseSync(code)
		insertWxsToRenderAst(ast, allScriptModules, scriptRes)
		code = generateCodeFromAst(ast)

		tplComponents
			+= `'${tm.path}':${code},`
	}
	tplComponents += '}'

	const tplAst = babel.parseSync(tplCode.code)
	insertWxsToRenderAst(tplAst, allScriptModules, scriptRes)
	const transCode = generateCodeFromAst(tplAst)

	const code = `Module({
		path: '${module.path}',
		id: '${module.id}',
		render: ${transCode},
		usingComponents: ${JSON.stringify(module.usingComponents)},
		tplComponents: ${tplComponents},
		});`

	// 更新缓存和结果
	const cacheData = {
		code: code,
		instruction: mergedInstruction
	}
	compileResCache.set(module.path, cacheData)
	scriptRes.set(module.path, code)
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
		if (attrName.endsWith(':if') || attrName.endsWith(':elif') || attrName.endsWith(':else')) {
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
	let content = getContentByPath(fullPath).trim()
	if (!content) {
		// 空文件内容，防止编译出错
		content = '<block></block>'
	}
	else {
		if (isComponent) {
			// TODO: 实现 componentPlaceholder，https://developers.weixin.qq.com/miniprogram/dev/framework/custom-component/placeholder.html
			// 自定义组件统一添加根节点，，手动声明继承关系来移除 wrapper 节点， https://cn.vuejs.org/guide/components/attrs#nested-component-inheritance
			content = `<wrapper name="${path}">${content}</wrapper>`
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
	})

	// 处理 include 节点
	// 可以将目标文件除了 <template/> <wxs/> 外的整个代码引入，相当于是拷贝到 include 位置
	const includeNodes = $('include')
	includeNodes.each((_, elem) => {
		const src = $(elem).attr('src')
		// 将目标文件除了 <template/> <wxs/> 外的整个代码引入，相当于是拷贝到 include 位置
		if (src) {
			const includeFullPath = getAbsolutePath(workPath, path, src)
			// 计算被包含文件的路径（去掉扩展名），用于 wxs 路径解析
			let includePath = includeFullPath.replace(workPath, '').replace(/\.(wxml|ddml)$/, '')
			
			// 确保路径以 / 开头
			if (!includePath.startsWith('/')) {
				includePath = '/' + includePath
			}
			
			const includeContent = getContentByPath(includeFullPath).trim()
			if (includeContent) {
				const $includeContent = cheerio.load(includeContent, {
					xmlMode: true,
					decodeEntities: false,
				})
				
				// 提取其中的 template 节点
				transTagTemplate(
					$includeContent,
					templateModule,
					includePath,
					components,
					componentPlaceholder,
				)

				// 提取其中的 wxs 节点
				transTagWxs(
					$includeContent,
					scriptModule,
					includePath,
				)
				
				// 处理被引入文件中的组件 wxs 依赖
				processIncludedFileWxsDependencies(includeContent, includePath, scriptModule, components, processedPaths)
				
				$includeContent('template').remove()
				$includeContent('wxs').remove()
				$includeContent('dds').remove()
				
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
	transTagTemplate($, templateModule, path, components, componentPlaceholder)

	// 处理 wxs 节点
	// https://developers.weixin.qq.com/miniprogram/dev/reference/wxs/01wxs-module.html
	transTagWxs($, scriptModule, path)

	// 处理 import 节点
	// https://developers.weixin.qq.com/miniprogram/dev/reference/wxml/import.html
	const importNodes = $('import')
	importNodes.each((_, elem) => {
		const src = $(elem).attr('src')
		if (src) {
			const importFullPath = getAbsolutePath(workPath, path, src)
			let importPath = importFullPath.replace(workPath, '').replace(/\.(wxml|ddml)$/, '')
			
			// 确保路径以 / 开头
			if (!importPath.startsWith('/')) {
				importPath = '/' + importPath
			}
			
			const importContent = getContentByPath(importFullPath).trim()
			if (importContent) {
				const $$ = cheerio.load(importContent, {
					xmlMode: true,
					decodeEntities: false,
				})
				// 提取其中的 template 节点
				transTagTemplate(
					$$,
					templateModule,
					path,
					components,
					componentPlaceholder,
				)

				// 提取其中的 wxs 节点
				transTagWxs(
					$$,
					scriptModule,
					importPath,
				)
				
				// 处理被导入文件中的组件 wxs 依赖
				processIncludedFileWxsDependencies(importContent, importPath, scriptModule, components, processedPaths)
			}
		}
	})
	importNodes.remove()

	transAsses($, $('image'), path)

	const res = []

	transHtmlTag($.html(), res, components, componentPlaceholder)

	return {
		tpl: res.join(''),
		instruction: {
			templateModule,
			scriptModule,
		},
	}
}

function transTagTemplate($, templateModule, path, components, componentPlaceholder) {
	const templateNodes = $('template[name]')
	templateNodes.each((_, elem) => {
		const name = $(elem).attr('name')
		const templateContent = $(elem)
		// 转化模板内代码
		templateContent.find('import').remove()
		templateContent.find('include').remove()
		templateContent.find('wxs').remove()
		templateContent.find('dds').remove()
		transAsses($, templateContent.find('image'), path)
		const res = []
		transHtmlTag(templateContent.html(), res, components, componentPlaceholder)

		templateModule.push({
			path: `tpl-${name}`,
			tpl: res.join(''),
		})
	})
	templateNodes.remove()
}

function transAsses($, imageNodes, path) {
	imageNodes.each((_, elem) => {
		// 获取所有的图片，不支持动态引用本地资源
		const imgSrc = $(elem).attr('src').trim()
		if (!imgSrc.startsWith('{{')) {
			$(elem).attr('src', collectAssets(getWorkPath(), path, imgSrc, getTargetPath(), getAppId()))
		}
	})
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
				res.push(text)
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

	parser.write(html)
	parser.end()
}

/**
 * 处理组件标签
 * @param {*} opts
 */
function transTag(opts) {
	const { isStart, tag, attrs, components } = opts
	let res
	if (tag === 'slot') {
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
	else if (!tagWhiteList.includes(tag)) {
		res = 'dd-text'
	}
	else {
		res = `dd-${tag}`
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
	// 用于记录属性绑定关系：{ 子组件属性名: 父组件数据路径 }
	const propBindings = {}
	
	Object.entries(attrs).forEach(([name, value]) => {
		if (name.endsWith(':if')) {
			attrsList.push({
				name: 'v-if',
				value: parseBraceExp(value),
			})
		}
		else if (name.endsWith(':elif')) {
			attrsList.push({
				name: 'v-else-if',
				value: parseBraceExp(value),
			})
		}
		else if (name.endsWith(':else')) {
			attrsList.push({
				name: 'v-else',
				value: '',
			})
		}
		else if (name.endsWith(':for') || name.endsWith(':for-items')) {
			attrsList.push({
				name: 'v-for',
				value: parseForExp(value, attrs),
			})
		}
		else if (name.endsWith(':for-item') || name.endsWith(':for-index')) {
			// do noting
		}
		else if (name.endsWith(':key')) {
			const tranValue = parseKeyExpression(value, getForItemName(attrs), getForIndexName(attrs))
			attrsList.push({
				name: ':key',
				value: tranValue,
			})
		}
		else if (name === 'style') {
			// 内联样式
			attrsList.push({
				name: 'v-c-style',
				value: transformRpx(parseBraceExp(value)),
			})
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
				value: '\'dd-\'+' + `${parseBraceExp(value)}`,
			})
		}
		else if (name === 'animation' && (tag !== 'movable-view' && tagWhiteList.includes(tag))) {
			// movable-view 有自己的 animation 属性
			// 自定义组件的属性有可能是 animation，所以只在普通组件节点生效
			attrsList.push({
				name: 'v-c-animation',
				value: parseBraceExp(value),
			})
		}
		else if ((name === 'value' && (tag === 'input' || tag === 'textarea'))
			|| ((name === 'x' || name === 'y') && tag === 'movable-view')
		) {
			const parsedValue = parseBraceExp(value)
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
					value: parseBraceExp(value),
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
			let pVal = parseBraceExp(value)
			if (tag === 'template' && name === 'data') {
				pVal = `{${pVal}}`
			}
			
			// 如果是自定义组件的属性绑定，记录绑定关系
			if (components && components[tag]) {
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
			// 替换引号是为了兼容 https://github.com/didi/mpx/blob/master/packages/webpack-plugin/lib/template-compiler/compiler.js#L1135
			propsRes.push(`${name}="${escapeQuotes(value)}"`)
		}
	})

	// 如果是自定义组件且有属性绑定，添加绑定信息
	if (components && components[tag] && Object.keys(propBindings).length > 0) {
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
	for (const mlType of fileType) {
		const mlFullPath = `${workPath}${aSrc}${mlType}`
		if (fs.existsSync(mlFullPath)) {
			return mlFullPath
		}
	}
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
		return parseBraceExp(item)
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
		if (key.endsWith(':for-item')) {
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
		if (key.endsWith(':for-index')) {
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
	const listVariableName = parseBraceExp(exp)
	return `(${item}, ${index}) in ${listVariableName}`
}

// 使用正则表达式匹配{{}}内的内容，并放入第一个分组
// 使用正则表达式匹配非{{}}内的内容，并放入第二个分组
// 使用全局标志g，表示匹配所有符合条件的部分
const braceRegex = /(\{\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\}\})|([^{}]+)/g
const noBraceRegex = /\{\{((?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*)\}\}/
const ternaryRegex = /[^?]+\?.+:.+/
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
				const statement = matchResult[1].trim()
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

function transTagWxs($, scriptModule, filePath) {
	let wxsNodes = $('wxs')
	if (wxsNodes.length === 0) {
		wxsNodes = $('dds')
	}
	
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
					// 为外部 wxs 文件生成唯一的模块名和缓存键
					const relativePath = wxsFilePath.replace(workPath, '').replace(/\.wxs$/, '')
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
				wxsContent = processWxsContent(wxsContent, wxsFilePath, scriptModule, workPath, filePath)

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
	// 如果模块路径不是 wxs 模块特征，直接返回 null
	if (!modulePath.startsWith('miniprogram_npm__') || !modulePath.includes('_wxs_')) {
		return null
	}
	
	// 从预先建立的路径映射中查找文件路径
	const wxsFilePath = wxsFilePathMap.get(modulePath)
	
	if (!wxsFilePath) {
		console.warn(`[view] 无法找到 wxs 模块文件: ${modulePath}`)
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

function insertWxsToRenderAst(ast, scriptModule, scriptRes) {
	for (const sm of scriptModule) {
		if (!scriptRes.has(sm.path)) {
			scriptRes.set(sm.path, sm.code)
		}
		
		// 使用原始模块名作为模板中的属性名，唯一模块名作为 require 的参数
		const templatePropertyName = sm.originalName || sm.path
		const requireModuleName = sm.path
		
		const assignmentExpression = types.assignmentExpression(
			'=',
			// 创建赋值表达式
			types.memberExpression(
				types.identifier('_ctx'), // 对象标识符
				types.identifier(templatePropertyName), // 使用原始模块名作为属性名
				false, // 是否是计算属性
			),

			// 创建require调用表达式
			types.callExpression(
				types.identifier('require'), // 函数标识符
				[types.stringLiteral(requireModuleName)], // 使用唯一模块名作为 require 参数
			),
		)

		// 将这个赋值表达式包装在一个表达式语句中
		const expressionStatement = types.expressionStatement(assignmentExpression)

		ast.program.body[0].expression.body.body.unshift(expressionStatement)
	}
}

export {
	compileML,
	generateVModelTemplate,
	generateSlotDirective,
	parseBraceExp,
	parseClassRules,
	parseKeyExpression,
	processIncludeConditionalAttrs,
	processWxsContent,
	splitWithBraces,
}
