import fs from 'node:fs'
import { resolve, sep } from 'node:path'
import { isMainThread, parentPort } from 'node:worker_threads'
import { parseSync } from 'oxc-parser'
import { walk } from 'oxc-walker'
import MagicString from 'magic-string'
import { transform } from 'esbuild'
import { collectAssets, hasCompileInfo } from '../common/utils.js'
import { getAppConfigInfo, getAppId, getComponent, getContentByPath, getNpmResolver, getTargetPath, getWorkPath, resetStoreInfo, resolveAppAlias } from '../env.js'
import { mergeSourcemap } from './sourcemap.js'

// 用于缓存已处理的模块
const processedModules = new Set()

// 是否生成 sourcemap
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
	const outputDir = root
		? `${getTargetPath()}/${root}`
		: `${getTargetPath()}/main`

	if (!fs.existsSync(outputDir)) {
		fs.mkdirSync(outputDir, { recursive: true })
	}

	/*
	 * sourcemap 模式跳过 minify：
	 * 当前 mergeSourcemap 只做单层行偏移拼接，
	 * 若再对 bundle 整体 minify 则需用 remapping 串联两份 map，暂未实现
	 */
	if (enableSourcemap) {
		const { bundleCode, sourcemap } = mergeSourcemap(compileRes)
		const sourcemapFileName = 'logic.js.map'
		fs.writeFileSync(`${outputDir}/logic.js`, `${bundleCode}//# sourceMappingURL=${sourcemapFileName}\n`)
		fs.writeFileSync(`${outputDir}/${sourcemapFileName}`, sourcemap)
	}
	else {
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
		fs.writeFileSync(`${outputDir}/logic.js`, mergeCode)
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
		sourceFile: null,
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
	const isTypeScript = modulePath.endsWith('.ts')

	// 记录源文件路径，用于 sourcemap
	if (enableSourcemap) {
		const workPath = getWorkPath()
		compileInfo.sourceFile = modulePath.startsWith(workPath)
			? modulePath.slice(workPath.length)
			: src
	}

	// 使用 oxc-parser 解析代码
	const parseResult = parseSync(modulePath, sourceCode, {
		sourceType: 'module',
		lang: isTypeScript ? 'ts' : 'js'
	})
	const ast = parseResult.program
	
	// 使用 MagicString 进行代码修改
	const s = new MagicString(sourceCode)

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

			await buildJSByPath(packageName, componentModule, compileRes, mainCompileRes, true, depthChain, putMain || toMainSubPackage)

			componentsObj[name] = path
		}
		extraInfo.usingComponents = componentsObj
	}

	// 如果需要添加 extraInfo，在代码开头注入
	if (addExtra) {
		const extraInfoCode = `globalThis.__extraInfo = ${JSON.stringify(extraInfo)};\n`
		if (enableSourcemap) {
			// 存到 compileInfo，在 modDefine header 中注入，避免影响 sourcemap 行号
			compileInfo.extraInfoCode = extraInfoCode
		} else {
			s.prepend(extraInfoCode)
		}
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
			if ((node.type === 'StringLiteral' || node.type === 'Literal') && isLocalAssetString(node.value)) {
				pathReplacements.push({
					start: node.start,
					end: node.end,
					newValue: collectAssets(getWorkPath(), modulePath, node.value, getTargetPath(), getAppId()),
				})
			}

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
						const { id, shouldProcess } = resolveDependencyId(requirePath, modulePath, false)
						
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
					const { id, shouldProcess } = resolveDependencyId(importPath, modulePath, true)
					
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

			// 处理 re-export 语句，如 export * from './foo'
			// 这类语句不会出现在运行时 require 中，必须在这里提前收集依赖。
			if (
				(node.type === 'ExportAllDeclaration' || node.type === 'ExportNamedDeclaration')
				&& node.source
			) {
				const exportPath = node.source.value
				if (exportPath) {
					const { id, shouldProcess } = resolveDependencyId(exportPath, modulePath, true)

					if (shouldProcess) {
						pathReplacements.push({
							start: node.source.start,
							end: node.source.end,
							newValue: id,
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
		await buildJSByPath(packageName, { path: depId }, compileRes, mainCompileRes, false, depthChain, putMain)
	}

	// 反向遍历修改，避免位置偏移
	for (const replacement of pathReplacements.reverse()) {
		s.overwrite(replacement.start, replacement.end, `'${replacement.newValue}'`)
	}

	const modifiedCode = s.toString()
	
	// 使用 esbuild 进行最终的 CommonJS 转换和压缩
	try {
		const esbuildOpts = {
			format: 'cjs',
			target: 'es2020',
			platform: 'neutral',
			loader: isTypeScript ? 'ts' : 'js',
		}
		/*
		 * 当前 sourcemap 仍是单步产出：
		 * - JS / TS 都先经过 MagicString 路径重写，再交给 esbuild 生成 map
		 * - 这样可避免 TS 先被 transpile 成 JS 后再伪装为 .ts 输出 sourcemap
		 * - 若要精确映射回“路径重写前”的原始源码列号，仍需串联 MagicString.generateMap() 做 remapping
		 */
		if (enableSourcemap && compileInfo.sourceFile) {
			esbuildOpts.sourcemap = true
			esbuildOpts.sourcefile = compileInfo.sourceFile
			esbuildOpts.sourcesContent = true
		}
		const esbuildResult = await transform(modifiedCode, esbuildOpts)

		if (enableSourcemap && esbuildResult.map) {
			compileInfo.map = esbuildResult.map
		}

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
							const { id } = resolveDependencyId(requirePath, modulePath, false)
							
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
		// 如果 esbuild 转换失败，使用路径改写后的源码
		compileInfo.code = modifiedCode
	}
	
	// 将当前模块标记为已处理
	processedModules.add(packageName + currentPath)
}

function isLocalAssetString(value) {
	return typeof value === 'string'
		&& !value.startsWith('http')
		&& !value.startsWith('//')
		&& (value.startsWith('/') || value.startsWith('./') || value.startsWith('../'))
		&& /\.(?:png|jpe?g|gif|svg)(?:\?.*)?$/.test(value)
}

/**
 * 获取 JavaScript 或 TypeScript 文件的绝对路径
 * @param {string} modulePath - 模块路径
 * @returns {string|null} - 文件的绝对路径，如果找不到则返回 null
 */
function getJSAbsolutePath(modulePath) {
	const workPath = getWorkPath()
	const resolvedModuleId = resolveModuleIdToExistingPath(modulePath)
	if (!resolvedModuleId) {
		return null
	}

	const fileTypes = ['.js', '.ts']
	for (const ext of fileTypes) {
		const fullPath = `${workPath}${resolvedModuleId}${ext}`
		if (fs.existsSync(fullPath)) {
			return fullPath
		}
	}

	return null
}

function resolveDependencyId(specifier, modulePath, allowAbsolute) {
	if (!specifier) {
		return { id: specifier, shouldProcess: false }
	}

	if (specifier.startsWith('miniprogram_npm/')) {
		const npmModuleId = normalizeModuleId(`/${specifier}`)
		return {
			id: resolveModuleIdToExistingPath(npmModuleId) || npmModuleId,
			shouldProcess: true,
		}
	}

	if (specifier.startsWith('./') || specifier.startsWith('../')) {
		return {
			id: resolveRelativeModuleId(specifier, modulePath),
			shouldProcess: true,
		}
	}

	if (specifier.startsWith('/')) {
		return {
			id: allowAbsolute ? normalizeModuleId(specifier) : resolveRelativeModuleId(specifier, modulePath),
			shouldProcess: true,
		}
	}

	const aliasResolved = resolveAppAlias(specifier)
	if (aliasResolved) {
		return {
			id: normalizeModuleId(aliasResolved),
			shouldProcess: true,
		}
	}

	if (specifier.startsWith('@') || isBareModuleSpecifier(specifier)) {
		const npmModuleId = resolveNpmModuleId(specifier, modulePath)
		return {
			id: npmModuleId || specifier,
			shouldProcess: Boolean(npmModuleId),
		}
	}

	return { id: specifier, shouldProcess: false }
}

function isBareModuleSpecifier(specifier) {
	return !specifier.startsWith('.') && !specifier.startsWith('/')
}

function resolveRelativeModuleId(specifier, modulePath) {
	const requireFullPath = resolve(modulePath, `../${specifier}`)
	const relativeId = requireFullPath.split(`${getWorkPath()}${sep}`)[1]
	return normalizeModuleId(relativeId)
}

function normalizeModuleId(moduleId) {
	let normalized = moduleId.replace(/\.(js|ts)$/, '').replace(/\\/g, '/')
	if (!normalized.startsWith('/')) {
		normalized = `/${normalized}`
	}
	return normalized
}

function resolveNpmModuleId(specifier, modulePath) {
	const npmResolver = getNpmResolver()
	if (!npmResolver) {
		return null
	}
	return npmResolver.resolveScriptModule(specifier, modulePath, resolveModuleIdToExistingPath)
}

function resolveModuleIdToExistingPath(moduleId) {
	const normalizedModuleId = normalizeModuleId(moduleId)
	const workPath = getWorkPath()

	for (const ext of ['.js', '.ts']) {
		if (fs.existsSync(`${workPath}${normalizedModuleId}${ext}`)) {
			return normalizedModuleId
		}
	}

	for (const ext of ['.js', '.ts']) {
		if (fs.existsSync(`${workPath}${normalizedModuleId}/index${ext}`)) {
			return `${normalizedModuleId}/index`
		}
	}

	const packageJsonPath = `${workPath}${normalizedModuleId}/package.json`
	if (fs.existsSync(packageJsonPath)) {
		try {
			const packageInfo = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'))
			for (const entryField of ['miniprogram', 'main']) {
				if (typeof packageInfo[entryField] === 'string' && packageInfo[entryField]) {
					const entryModuleId = normalizeModuleId(resolve(normalizedModuleId, packageInfo[entryField]))
					const resolvedEntry = resolveModuleIdToExistingPath(entryModuleId)
					if (resolvedEntry) {
						return resolvedEntry
					}
				}
			}
		}
		catch (error) {
			console.warn('[logic]', `解析 package.json 失败: ${packageJsonPath}`, error.message)
		}
	}

	return null
}

export { compileJS, buildJSByPath }
