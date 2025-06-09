import fs from 'node:fs'
import { resolve } from 'node:path'
import { isMainThread, parentPort } from 'node:worker_threads'
import babel from '@babel/core'
import _traverse from '@babel/traverse'
import types from '@babel/types'
import { transform } from 'esbuild'
import { hasCompileInfo } from '../common/utils.js'
import { getAppConfigInfo, getComponent, getContentByPath, getTargetPath, getWorkPath, resetStoreInfo } from '../env.js'

// https://github.com/babel/babel/issues/13855
const traverse = _traverse.default ? _traverse.default : _traverse

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
			parentPort.postMessage({ success: true })
		}
		catch (error) {
			parentPort.postMessage({
				success: false,
				error: {
					message: error.message,
					stack: error.stack,
					name: error.name,
					file: error.file || null,
					line: error.line || null,
					code: error.code || null,
				},
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
		buildJSByPath(root, { path: 'app' }, compileRes, mainCompileRes, false)
	}

	pages.forEach((page) => {
		buildJSByPath(root, page, compileRes, mainCompileRes, true)
		progress.completedTasks++
	})

	return compileRes
}

function buildJSByPath(packageName, module, compileRes, mainCompileRes, addExtra, depthChain = [], putMain = false) {
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
	const modulePath = `${getWorkPath()}${src}.js`
	const js = getContentByPath(modulePath)
	const ast = babel.parseSync(js)

	const addedArgs = types.objectExpression([
		types.objectProperty(types.identifier('path'), types.stringLiteral(module.path)),
	])

	// https://developers.weixin.qq.com/miniprogram/dev/framework/custom-component/
	// 将 component 字段设为 true 可将这一组文件设为自定义组件
	if (module.component) {
		const component = types.objectProperty(types.identifier('component'), types.booleanLiteral(true))
		addedArgs.properties.push(component)
	}

	if (module.usingComponents) {
		const components = types.objectProperty(types.identifier('usingComponents'), types.objectExpression([]))
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

			buildJSByPath(packageName, componentModule, compileRes, mainCompileRes, true, depthChain, toMainSubPackage)

			const props = types.objectProperty(types.identifier(`'${name}'`), types.stringLiteral(path))
			components.value.properties.push(props)
		}
		addedArgs.properties.push(components)
	}

	if (addExtra) {
		ast.program.body.splice(0, 0, getExtraInfoStatement('this', addedArgs))
	}

	if (putMain) {
		mainCompileRes.push(compileInfo)
	}
	else {
		compileRes.push(compileInfo)
	}

	traverse(ast, {
		CallExpression(ap) {
			if (ap.node.callee.name === 'require' || ap.node.callee.object?.name === 'require') {
				// TODO: ap.node.callee.property?.name === 'async'
				const requirePath = ap.node.arguments[0].value
				if (requirePath) {
					const requireFullPath = resolve(modulePath, `../${requirePath}`)
					// 依赖的模块相对路径转换为绝对路径
					const id = requireFullPath.split(`${getWorkPath()}/`)[1].split('.js')[0]
					ap.node.arguments[0] = types.stringLiteral(id)
					if (!processedModules.has(packageName + id)) {
						buildJSByPath(packageName, { path: id }, compileRes, mainCompileRes, false, depthChain)
					}
				}
			}
		},
	})

	const { code } = babel.transformFromAstSync(ast, '', {
		comments: false,
	})
	compileInfo.code = code
	// 将当前模块标记为已处理
	processedModules.add(packageName + currentPath)
}

/**
 * 生成一条赋值语句
 * @param {*} type
 * @param {*} addedArgs
 */
function getExtraInfoStatement(type, addedArgs) {
	const propertyAssignment = types.objectProperty(types.identifier('__extraInfo'), addedArgs)
	const propertyAssignmentStatement = types.expressionStatement(
		types.assignmentExpression(
			'=',
			types.memberExpression(types.identifier(type), propertyAssignment.key),
			propertyAssignment.value,
		),
	)

	return propertyAssignmentStatement
}

export { buildJSByPath }
export default compileJS