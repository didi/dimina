import fs from 'node:fs'
import { resolve, sep } from 'node:path'
import { isMainThread, parentPort } from 'node:worker_threads'
import { parseSync } from 'oxc-parser'
import { walk } from 'oxc-walker'
import { transformSync } from 'oxc-transform'
import MagicString from 'magic-string'
import { transform } from 'esbuild'
import ts from 'typescript'
import { hasCompileInfo } from '../common/utils.js'
import { getAppConfigInfo, getComponent, getContentByPath, getTargetPath, getWorkPath, resetStoreInfo } from '../env.js'

// 用于缓存已处理的模块
const processedModules = new Set()

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
					parentPort.postMessage({ completedTasks: this.completedTasks })
				},
			}

			const mainCompileRes = await compileJS(pages.mainPages, null, null, progress)
			for (const [root, subPages] of Object.entries(pages.subPages)) {
				try {
					// 独立分包: https://developers.weixin.qq.com/miniprogram/dev/framework/subpackages/independent.html
					const subCompileRes = await compileJS(
						subPages.info,
						root,
						subPages.independent ? [] : mainCompileRes,
						progress,
					)
					await writeCompileRes(subCompileRes, root)
				}
				catch (error) {
					throw new Error(`Error processing subpackage ${root}: ${error.message}\n${error.stack}`)
				}
			}
			await writeCompileRes(mainCompileRes, null)
			
			// Worker 任务完成后清理缓存，释放内存
			processedModules.clear()
			
			parentPort.postMessage({ success: true })
		}
		catch (error) {
			// 错误时也清理缓存
			processedModules.clear()
			
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

async function writeCompileRes(compileRes, root) {
	let mergeCode = ''
	for (const module of compileRes) {
		const amdFormat = `modDefine('${module.path}', function(require, module, exports) {
${module.code}
});`
		//TODO: 替换成 https://oxc.rs/docs/guide/usage/minifier.html
		const { code: minifiedCode } = await transform(amdFormat, {
			minify: true,
			target: ['es2023'], // quickjs 支持版本
			platform: 'neutral',
		})
		mergeCode += minifiedCode
	}

	if (root) {
		const subDir = `${getTargetPath()}/${root}`
		if (!fs.existsSync(subDir)) {
			fs.mkdirSync(subDir, { recursive: true })
		}
		fs.writeFileSync(`${subDir}/logic.js`, mergeCode)
	}
	else {
		const mainDir = `${getTargetPath()}/main`
		if (!fs.existsSync(mainDir)) {
			fs.mkdirSync(mainDir, { recursive: true })
		}
		fs.writeFileSync(`${mainDir}/logic.js`, mergeCode)
	}
}

/**
 * 编译 js 文件
 */
async function compileJS(pages, root, mainCompileRes, progress) {
	const compileRes = []
	if (!root) {
		await buildJSByPath(root, { path: 'app' }, compileRes, mainCompileRes, false)
	}

	for (const page of pages) {
		await buildJSByPath(root, page, compileRes, mainCompileRes, true)
		progress.completedTasks++
	}

	return compileRes
}

async function buildJSByPath(packageName, module, compileRes, mainCompileRes, addExtra, depthChain = [], putMain = false) {
	// Track dependency chain to detect potential circular dependencies
	const currentPath = module.path

	// Circular dependency detected
	if (depthChain.includes(currentPath)) {
		console.warn('[logic]', `检测到循环依赖: ${[...depthChain, currentPath].join(' -> ')}`)
		return
	}
	// Deep dependency chain detected
	if (depthChain.length > 20) {
		console.warn('[logic]', `检测到深度依赖: ${[...depthChain, currentPath].join(' -> ')}`)
		return
	}
	depthChain = [...depthChain, currentPath]
	if (!module.path) {
		// 业务逻辑不存在
		return
	}
	// 防止添加相同的 js
	if (hasCompileInfo(module.path, compileRes, mainCompileRes)) {
		return
	}
	const compileInfo = {
		path: module.path,
		code: '',
	}

	const src = module.path.startsWith('/') ? module.path : `/${module.path}`
	const modulePath = getJSAbsolutePath(src)
	if (!modulePath) {
		console.warn('[logic]', `找不到模块文件: ${src}`)
		return
	}
	
	const sourceCode = getContentByPath(modulePath)
	if (!sourceCode) {
		console.warn('[logic]', `无法读取模块文件: ${modulePath}`)
		return
	}
	
	// 如果是 TypeScript 文件，先编译为 JavaScript
	let jsCode = sourceCode
	if (modulePath.endsWith('.ts')) {
		try {
			const result = ts.transpileModule(sourceCode, {
				compilerOptions: {
					target: ts.ScriptTarget.ES2020,
					module: ts.ModuleKind.ESNext, // 保持 ES6 模块语法，让 oxc-transform 后续处理
					strict: false,
					esModuleInterop: true,
					skipLibCheck: true,
				},
			})
			jsCode = result.outputText
		} catch (error) {
			console.error(`[logic] TypeScript 编译失败 ${modulePath}:`, error.message)
			// 如果 TypeScript 编译失败，尝试使用原始代码
			jsCode = sourceCode
		}
	}
	
	// 使用 oxc-parser 解析代码
	const parseResult = parseSync(modulePath, jsCode, {
		sourceType: 'module',
		lang: modulePath.endsWith('.ts') ? 'ts' : 'js'
	})
	const ast = parseResult.program
	
	// 使用 MagicString 进行代码修改
	const s = new MagicString(jsCode)

	// 构建 extraInfo 对象（使用 JSON 而不是 AST）
	const extraInfo = {
		path: module.path
	}

	// https://developers.weixin.qq.com/miniprogram/dev/framework/custom-component/
	// 将 component 字段设为 true 可将这一组文件设为自定义组件
	if (module.component) {
		extraInfo.component = true
	}

	if (module.usingComponents) {
		const componentsObj = {}
		const allSubPackages = getAppConfigInfo().subPackages

		for (const [name, path] of Object.entries(module.usingComponents)) {
			let toMainSubPackage = true
			if (packageName) {
				// 如果依赖的组件不在当前的分包，则跳过该组件的编译逻辑，保证分包代码的独立性
				// 考虑到路径可能是 'test/src' 这样的格式，使用前缀匹配而不是分割比较
				const normalizedPath = path.startsWith('/') ? path.substring(1) : path

				// 如果不属于任意分包则将逻辑移动到主包
				for (const subPackage of allSubPackages) {
					if (normalizedPath.startsWith(`${subPackage.root}/`)) {
						toMainSubPackage = false
						break
					}
				}
			}
			else {
				toMainSubPackage = false
			}

			const componentModule = getComponent(path)
			if (!componentModule) {
				continue
			}

			await buildJSByPath(packageName, componentModule, compileRes, mainCompileRes, true, depthChain, toMainSubPackage)

			componentsObj[name] = path
		}
		extraInfo.usingComponents = componentsObj
	}

	// 如果需要添加 extraInfo，在代码开头注入
	if (addExtra) {
		const extraInfoCode = `globalThis.__extraInfo = ${JSON.stringify(extraInfo)};\n`
		s.prepend(extraInfoCode)
	}

	if (putMain) {
		mainCompileRes.push(compileInfo)
	}
	else {
		compileRes.push(compileInfo)
	}

	// 收集需要修改的路径信息和依赖模块
	const pathReplacements = []
	const dependenciesToProcess = []

	walk(ast, {
		enter(node, parent) {
			// 处理 require() 调用
			if (node.type === 'CallExpression') {
				// 检查是否是 require() 调用
				const isRequire = node.callee.type === 'Identifier' && node.callee.name === 'require'
				const isRequireProperty = node.callee.type === 'MemberExpression' && 
					node.callee.object?.type === 'Identifier' && 
					node.callee.object?.name === 'require'
				
				if ((isRequire || isRequireProperty) && 
					node.arguments.length > 0 && 
					(node.arguments[0].type === 'StringLiteral' || node.arguments[0].type === 'Literal')) {
					const arg = node.arguments[0]
					const requirePath = arg.value
					
					if (requirePath) {
						let id
						let shouldProcess = true
						
						// // 处理不同类型的 require 路径
						// if (requirePath.startsWith('@') || requirePath.startsWith('miniprogram_npm/')) {
						// 	// 处理 npm 包导入（如 @vant/weapp/toast/toast）
						// 	if (requirePath.startsWith('@')) {
						// 		// 转换为 miniprogram_npm 路径
						// 		id = `/miniprogram_npm/${requirePath}`
						// 	} else {
						// 		// 已经是 miniprogram_npm 路径
						// 		id = requirePath.startsWith('/') ? requirePath : `/${requirePath}`
						// 	}
						// } else {
						// 	// 其他所有路径（相对路径、绝对路径等）都进行解析
						// 	// 这与 Babel 原版逻辑保持一致
						// 	const requireFullPath = resolve(modulePath, `../${requirePath}`)
						// 	// 依赖的模块相对路径转换为绝对路径
						// 	id = requireFullPath.split(`${getWorkPath()}${sep}`)[1]
						// 	// 移除文件扩展名（.js 或 .ts）
						// 	id = id.replace(/\.(js|ts)$/, '').replace(/\\/g, '/')
						// 	// 确保路径以 '/' 开头，保持一致性
						// 	if (!id.startsWith('/')) {
						// 		id = '/' + id
						// 	}
						// }
						// 处理 miniprogram_npm 路径
						const isMiniprogramNpm = requirePath === 'miniprogram_npm' ||
								requirePath.startsWith('miniprogram_npm/') ||
								requirePath.startsWith('/miniprogram_npm/')

						// 判断是否为相对路径
						const isRelative = requirePath.startsWith('./') || requirePath.startsWith('../')

						const isAbsolute = requirePath.startsWith('/')

						// 是否是 npm 包（不以 ./ ../ / 开头，且不是 miniprogram_npm）
						const isNpmPackage = !isRelative && !isMiniprogramNpm && !isAbsolute

						if (isNpmPackage) {
							// npm 包统一映射到 /miniprogram_npm/
							id = `/miniprogram_npm/${requirePath}`
						} else if (isMiniprogramNpm) {
							// 保持原有 miniprogram_npm 路径
							id = requirePath.startsWith('/') ? requirePath : `/${requirePath}`
						} else {
							// 相对路径 / 其他绝对路径
							const requireFullPath = resolve(modulePath, `../${requirePath}`)
							id = requireFullPath.split(`${getWorkPath()}${sep}`)[1]
							id = id.replace(/\.(js|ts)$/, '').replace(/\\/g, '/')
							if (!id.startsWith('/')) {
								id = '/' + id
							}
						}
						
						if (shouldProcess) {
							pathReplacements.push({
								start: arg.start,
								end: arg.end,
								newValue: id
							})
							
							if (!processedModules.has(packageName + id)) {
								dependenciesToProcess.push(id)
							}
						}
					}
				}
			}
			
			// 处理 ES6 import 语句
			if (node.type === 'ImportDeclaration') {
				const importPath = node.source.value
				if (importPath) {
					let id
					let shouldProcess = false
					
					// if (importPath.startsWith('@') || importPath.startsWith('miniprogram_npm/')) {
					// 	// 处理 npm 包导入（如 @vant/weapp/toast/toast）
					// 	if (importPath.startsWith('@')) {
					// 		// 转换为 miniprogram_npm 路径
					// 		id = `/miniprogram_npm/${importPath}`
					// 	} else {
					// 		// 已经是 miniprogram_npm 路径
					// 		id = importPath.startsWith('/') ? importPath : `/${importPath}`
					// 	}
					// 	shouldProcess = true
					// } else if (importPath.startsWith('./') || importPath.startsWith('../') || !importPath.startsWith('/')) {
					// 	// 处理相对路径导入
					// 	const importFullPath = resolve(modulePath, `../${importPath}`)
					// 	// 依赖的模块相对路径转换为绝对路径
					// 	id = importFullPath.split(`${getWorkPath()}${sep}`)[1]
					// 	// 移除文件扩展名（.js 或 .ts）
					// 	id = id.replace(/\.(js|ts)$/, '').replace(/\\/g, '/')
					// 	// 确保路径以 '/' 开头，保持一致性
					// 	if (!id.startsWith('/')) {
					// 		id = '/' + id
					// 	}
					// 	shouldProcess = true
					// } else {
					// 	// 绝对路径直接使用
					// 	id = importPath
					// 	shouldProcess = true
					// }
					// 处理 miniprogram_npm 路径
					const isMiniprogramNpm = importPath === 'miniprogram_npm' ||
							importPath.startsWith('miniprogram_npm/') ||
							importPath.startsWith('/miniprogram_npm/')

					// 判断是否为相对路径
					const isRelative = importPath.startsWith('./') || importPath.startsWith('../')

					const isAbsolute = importPath.startsWith('/')

					// 是否是 npm 包（不以 ./ ../ / 开头，且不是 miniprogram_npm）
					const isNpmPackage = !isRelative && !isMiniprogramNpm && !isAbsolute

					if (isNpmPackage) {
						// npm 包统一映射到 /miniprogram_npm/
						id = `/miniprogram_npm/${importPath}`
						shouldProcess = true
					} else if (isMiniprogramNpm) {
						// 保持原有 miniprogram_npm 路径
						id = importPath.startsWith('/') ? importPath : `/${importPath}`
						shouldProcess = true
					} else {
						// 相对路径 / 其他绝对路径
						const importFullPath = resolve(modulePath, `../${importPath}`)
						id = importFullPath.split(`${getWorkPath()}${sep}`)[1]
						id = id.replace(/\.(js|ts)$/, '').replace(/\\/g, '/')
						if (!id.startsWith('/')) {
							id = '/' + id
						}
						shouldProcess = true
					}
					
					if (shouldProcess) {
						pathReplacements.push({
							start: node.source.start,
							end: node.source.end,
							newValue: id
						})
						
						if (!processedModules.has(packageName + id)) {
							dependenciesToProcess.push(id)
						}
					}
				}
			}
		}
	})

	// 处理所有依赖模块（异步）
	for (const depId of dependenciesToProcess) {
		await buildJSByPath(packageName, { path: depId }, compileRes, mainCompileRes, false, depthChain)
	}

	// 反向遍历修改，避免位置偏移
	for (const replacement of pathReplacements.reverse()) {
		s.overwrite(replacement.start, replacement.end, `'${replacement.newValue}'`)
	}

	// 使用 oxc-transform 进行 TypeScript 和 JSX 转换
	const modifiedCode = s.toString()
	let transformedCode = modifiedCode
	
	// 如果是 TypeScript 文件，使用 oxc-transform 进行类型擦除
	if (modulePath.endsWith('.ts') || modulePath.endsWith('.tsx')) {
		try {
			const result = transformSync(modulePath, modifiedCode, {
				sourceType: 'module',
				lang: modulePath.endsWith('.tsx') ? 'tsx' : 'ts',
				target: 'es2020',
				typescript: {
					onlyRemoveTypeImports: true
				}
			})
			transformedCode = result.code
		} catch (error) {
			console.error(`[logic] oxc-transform 转换失败 ${modulePath}:`, error.message)
			// 如果转换失败，使用修改后的代码
			transformedCode = modifiedCode
		}
	}
	
	// 使用 esbuild 进行最终的 CommonJS 转换和压缩
	// 这是必需的，因为 oxc-transform 不支持模块格式转换
	try {
		const esbuildResult = await transform(transformedCode, {
			format: 'cjs',
			target: 'es2020',
			platform: 'neutral',
			loader: 'js'
		})
		
		// esbuild 转换后，需要再次处理生成的 require 调用
		// 因为 esbuild 可能生成新的 require 调用（从 import 转换而来）
		const esbuildCode = esbuildResult.code
		
		// 解析 esbuild 输出的代码
		const esbuildAst = parseSync(modulePath, esbuildCode, {
			sourceType: 'module',
			lang: 'js'
		})
		
		// 再次收集需要修改的 require 路径
		const postEsbuildReplacements = []
		walk(esbuildAst.program, {
			enter(node) {
				if (node.type === 'CallExpression') {
					const isRequire = node.callee.type === 'Identifier' && node.callee.name === 'require'
					const isRequireProperty = node.callee.type === 'MemberExpression' && 
						node.callee.object?.type === 'Identifier' && 
						node.callee.object?.name === 'require'
					
					if ((isRequire || isRequireProperty) && 
						node.arguments.length > 0 && 
						(node.arguments[0].type === 'StringLiteral' || node.arguments[0].type === 'Literal')) {
						const arg = node.arguments[0]
						const requirePath = arg.value
						
						// 只处理仍然是相对路径的 require（说明没有被正确转换）
						if (requirePath && (requirePath.startsWith('./') || requirePath.startsWith('../'))) {
							let id
							if (requirePath.startsWith('@') || requirePath.startsWith('miniprogram_npm/')) {
								if (requirePath.startsWith('@')) {
									id = `/miniprogram_npm/${requirePath}`
								} else {
									id = requirePath.startsWith('/') ? requirePath : `/${requirePath}`
								}
							} else {
								const requireFullPath = resolve(modulePath, `../${requirePath}`)
								id = requireFullPath.split(`${getWorkPath()}${sep}`)[1]
								id = id.replace(/\.(js|ts)$/, '').replace(/\\/g, '/')
								if (!id.startsWith('/')) {
									id = '/' + id
								}
							}
							
							postEsbuildReplacements.push({
								start: arg.start,
								end: arg.end,
								newValue: id
							})
						}
					}
				}
			}
		})
		
		// 如果有需要修改的路径，应用修改
		if (postEsbuildReplacements.length > 0) {
			const finalMagicString = new MagicString(esbuildCode)
			for (const replacement of postEsbuildReplacements.reverse()) {
				finalMagicString.overwrite(replacement.start, replacement.end, `"${replacement.newValue}"`)
			}
			compileInfo.code = finalMagicString.toString()
		} else {
			compileInfo.code = esbuildCode
		}
	} catch (error) {
		console.error(`[logic] esbuild 转换失败 ${modulePath}:`, error.message)
		// 如果 esbuild 转换失败，使用 oxc 转换后的代码
		compileInfo.code = transformedCode
	}
	
	// 将当前模块标记为已处理
	processedModules.add(packageName + currentPath)
}

/**
 * 获取 JavaScript 或 TypeScript 文件的绝对路径
 * @param {string} modulePath - 模块路径
 * @returns {string|null} - 文件的绝对路径，如果找不到则返回 null
 */
function getJSAbsolutePath(modulePath) {
	const workPath = getWorkPath()
	const fileTypes = ['.js', '.ts']
	
	for (const ext of fileTypes) {
		const fullPath = `${workPath}${modulePath}${ext}`
		if (fs.existsSync(fullPath)) {
			return fullPath
		}
		// 尝试查找 index.js 或 index.ts
		const fullPathWithIndex = `${workPath}${modulePath}/index${ext}`
		if (fs.existsSync(fullPathWithIndex)) {
			return fullPathWithIndex
		}
	}
	
	return null
}

export { compileJS, buildJSByPath }
