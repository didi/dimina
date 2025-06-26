import fs from 'node:fs'
import path from 'node:path'
import { isMainThread, parentPort } from 'node:worker_threads'
import { compileStyle } from '@vue/compiler-sfc'
import autoprefixer from 'autoprefixer'
import cssnano from 'cssnano'
import less from 'less'
import postcss from 'postcss'
import selectorParser from 'postcss-selector-parser'
import * as sass from 'sass'
import { collectAssets, tagWhiteList, transformRpx } from '../common/utils.js'
import { getAppId, getComponent, getContentByPath, getTargetPath, getWorkPath, resetStoreInfo } from '../env.js'

const fileType = ['.wxss', '.ddss', '.less', '.scss', '.sass']
const compileRes = new Map()

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

			await compileSS(pages.mainPages, null, progress)

			for (const [root, subPages] of Object.entries(pages.subPages)) {
				await compileSS(subPages.info, root, progress)
			}

			parentPort.postMessage({ success: true })
		}
		catch (error) {
			parentPort.postMessage({ success: false, error: error.message })
		}
	})
}

/**
 *  编译样式文件
 */
async function compileSS(pages, root, progress) {
	// page 样式
	for (const page of pages) {
		const code = await buildCompileCss(page, []) || ''
		const filename = `${page.path.replace(/\//g, '_')}`
		if (root) {
			const subDir = `${getTargetPath()}/${root}`
			if (!fs.existsSync(subDir)) {
				fs.mkdirSync(subDir, { recursive: true })
			}

			fs.writeFileSync(`${subDir}/${filename}.css`, code)
		}
		else {
			const mainDir = `${getTargetPath()}/main`
			if (!fs.existsSync(mainDir)) {
				fs.mkdirSync(mainDir, { recursive: true })
			}

			fs.writeFileSync(`${mainDir}/${filename}.css`, code)
		}

		progress.completedTasks++
	}
}

async function buildCompileCss(module, depthChain = []) {
	const currentPath = module.path

	// Circular dependency detected
	if (depthChain.includes(currentPath)) {
		console.warn('[style]', `检测到循环依赖: ${[...depthChain, currentPath].join(' -> ')}`)
		return
	}
	// Deep dependency chain detected
	if (depthChain.length > 20) {
		console.warn('[style]', `检测到深度依赖: ${[...depthChain, currentPath].join(' -> ')}`)
		return
	}
	depthChain = [...depthChain, currentPath]
	let result = await enhanceCSS(module) || ''

	if (module.usingComponents) {
		// component 样式
		// 组件对应 wxss 文件的样式，只对组件 wxml 内的节点生效
		// https://developers.weixin.qq.com/miniprogram/dev/framework/custom-component/wxml-wxss.html
		for (const componentInfo of Object.values(module.usingComponents)) {
			const componentModule = getComponent(componentInfo)
			if (!componentModule) {
				continue
			}
			result += await buildCompileCss(componentModule, depthChain)
		}
	}

	return result
}

async function enhanceCSS(module) {
	const absolutePath = module.absolutePath ? module.absolutePath : getAbsolutePath(module.path)
	if (!absolutePath) {
		// 样式文件不存在
		return
	}

	const inputCSS = getContentByPath(absolutePath)
	if (!inputCSS) {
		return
	}

	if (compileRes.has(absolutePath)) {
		return compileRes.get(absolutePath)
	}

	// 预处理器编译
	let processedCSS = inputCSS
	const ext = path.extname(absolutePath).toLowerCase()
	
	try {
		if (ext === '.less') {
			const result = await less.render(inputCSS, {
				filename: absolutePath,
				paths: [path.dirname(absolutePath)],
			})
			processedCSS = result.css
		} else if (ext === '.scss' || ext === '.sass') {
			const result = sass.compileString(inputCSS, {
				loadPaths: [path.dirname(absolutePath)],
				syntax: ext === '.sass' ? 'indented' : 'scss',
			})
			processedCSS = result.css
		}
	} catch (error) {
		console.error(`[style] 预处理器编译失败 ${absolutePath}:`, error.message)
		// 如果预处理器编译失败，使用原始内容继续处理
		processedCSS = inputCSS
	}

	const fixedCSS = ensureImportSemicolons(processedCSS)

	let ast
	try {
		ast = postcss.parse(fixedCSS)
	} catch (error) {
		console.error(`[style] PostCSS 解析失败 ${absolutePath}:`, error.message)
		// 如果 PostCSS 解析失败，返回空字符串
		return ''
	}
	const promises = []
	ast.walk(async (node) => {
		if (node.type === 'atrule' && node.name === 'import') {
			// @import 样式导入
			// 替换字符串首尾的引号
			const str = node.params.replace(/^['"]|['"]$/g, '')
			const importFullPath = path.resolve(absolutePath, `../${str}`)

			node.remove()

			promises.push(buildCompileCss({ absolutePath: importFullPath, id: module.id }))
		}
		else if (node.type === 'rule') {
			// 处理 ::v-deep
			if (node.selector.includes('::v-deep')) {
				node.selector = node.selector.replace(/::v-deep\s+(\S[^{]*)/g, ':deep($1)')
			}

			node.selector = selectorParser((selectors) => {
				selectors.walkTags((tag) => {
					if (tagWhiteList.includes(tag.value)) {
						// 将组件样式转换成类样式
						tag.value = `.dd-${tag.value}`
					}
				})
			}).processSync(node.selector)

			// 普通css规则
			node.walkDecls((decl) => {
				// 处理样式中的资源
				const match = decl.value.match(/url\("([^"]*)"\)/)
				if (match) {
					const imgSrc = match[1].trim()
					// Skip processing if it's a data:image resource
					if (imgSrc.startsWith('data:image')) {
						return
					}
					const realSrc = collectAssets(getWorkPath(), absolutePath, imgSrc, getTargetPath(), getAppId())
					decl.value = `url(${realSrc})`
				}
				else {
					decl.value = transformRpx(decl.value)
				}
			})
		}
		else if (node.type === 'comment') {
			// 移除注释
			node.remove()
		}
	})

	const cssCode = ast.toResult().css

	// 样式隔离
	const moduleId = module.id || module.path || 'default'
	const code = compileStyle({
		source: cssCode,
		id: moduleId,
		scoped: !!moduleId,
	}).code

	const res = await postcss([autoprefixer({ overrideBrowserslist: ['cover 99.5%'] }), cssnano()]).process(code, {
		from: undefined, // 未指定输入源文件路径
	})

	// 处理导入的样式
	const importCss = (await Promise.all(promises))
		.filter(Boolean)
		.join('')

	const result = importCss ? importCss + res.css : res.css

	compileRes.set(module.path, result)

	return result
}

function getAbsolutePath(modulePath) {
	const workPath = getWorkPath()
	const src = modulePath.startsWith('/') ? modulePath : `/${modulePath}`

	for (const ssType of fileType) {
		const ssFullPath = `${workPath}${src}${ssType}`
		if (fs.existsSync(ssFullPath)) {
			return ssFullPath
		}
	}
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

export { compileSS, ensureImportSemicolons }
