import fs from 'node:fs'
import { isMainThread, parentPort } from 'node:worker_threads'
import babel from '@babel/core'
import _traverse from '@babel/traverse'
import types from '@babel/types'
import { compileTemplate } from '@vue/compiler-sfc'
import * as cheerio from 'cheerio'
import { transform } from 'esbuild'
import * as htmlparser2 from 'htmlparser2'
import { collectAssets, getAbsolutePath, tagWhiteList, transformRpx } from '../common/utils.js'
import { getAppId, getComponent, getContentByPath, getTargetPath, getWorkPath, resetStoreInfo } from '../env.js'

// https://github.com/babel/babel/issues/13855
const traverse = _traverse.default ? _traverse.default : _traverse

const fileType = ['.wxml', '.ddml']
// 页面文件编译内容缓存
const compileResCache = new Map()

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

					parentPort.postMessage({ completedTasks: this._completedTasks })
				},
			}

			await compileML(pages.mainPages, null, progress)

			for (const [root, subPages] of Object.entries(pages.subPages)) {
				await compileML(subPages.info, root, progress)
			}

			parentPort.postMessage({ success: true })
		}
		catch (error) {
			parentPort.postMessage({ success: false, error: error.message })
		}
	})
}

/**
 * 编译页面视图文件
 */
async function compileML(pages, root, progress) {
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

function buildCompileView(module, isComponent = false, scriptRes, depthChain = []) {
	const currentPath = module.path

	if (processedModules.has(currentPath)) {
		// 如果当前模块已经处理过，则跳过
		return
	}

	// 将当前模块标记为已处理, 提前标记
	processedModules.add(currentPath)

	// Circular dependency detected
	if (depthChain.includes(currentPath)) {
		console.warn('[view]', `检测到循环依赖: ${[...depthChain, currentPath].join(' -> ')}`)
	}
	// Deep dependency chain detected
	if (depthChain.length > 100) {
		console.warn('[view]', `检测到深度依赖: ${[...depthChain, currentPath].join(' -> ')}`)
	}
	depthChain = [...depthChain, currentPath]
	compileModule(module, isComponent, scriptRes)

	if (module.usingComponents) {
		for (const componentInfo of Object.values(module.usingComponents)) {
			const componentModule = getComponent(componentInfo)
			if (!componentModule) {
				continue
			}
			buildCompileView(componentModule, true, scriptRes, depthChain)
		}
	}
}

/**
 * 编译页面及自定义组件，自定义组件可认为是特殊的页面
 * https://developers.weixin.qq.com/miniprogram/dev/framework/custom-component/
 * @param {*} module
 */
function compileModule(module, isComponent, scriptRes) {
	const { tpl, instruction } = toCompileTemplate(isComponent, module.path, module.usingComponents, module.componentPlaceholder)
	if (!tpl) {
		return
	}

	if (!scriptRes.has(module.path) && compileResCache.has(module.path)) {
		const res = compileResCache.get(module.path)
		scriptRes.set(module.path, res)
		for (const sm of instruction.scriptModule) {
			if (!scriptRes.has(sm.path)) {
				scriptRes.set(sm.path, sm.code)
			}
		}
		return
	}

	// console.log(module.path, tpl)

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
		insertWxsAssignToRenderAst(ast, instruction.scriptModule, scriptRes)
		code = babel.transformFromAstSync(ast, '', {
			comments: false,
		}).code

		tplComponents
			+= `'${tm.path}':${code.replace(/;$/, '').replace(/^"use strict";\s*/, '')},`
	}
	tplComponents += '}'

	const tplAst = babel.parseSync(tplCode.code)
	insertWxsAssignToRenderAst(tplAst, instruction.scriptModule, scriptRes)
	const { code: transCode } = babel.transformFromAstSync(tplAst, '', {
		comments: false,
	})

	// console.log(tplCode.code)

	// 通过 component 字段标记该页面 以 Component 形式进行渲染或着以 Page 形式进行渲染
	// https://developers.weixin.qq.com/miniprogram/dev/framework/app-service/page.html
	// https://developers.weixin.qq.com/miniprogram/dev/framework/custom-component/component.html
	const code = `Module({
		path: '${module.path}',
		id: '${module.id}',
		render: ${transCode.replace(/;$/, '').replace(/^"use strict";\s*/, '')},
		usingComponents: ${JSON.stringify(module.usingComponents)},
		tplComponents: ${tplComponents},
		});`

	compileResCache.set(module.path, code)
	scriptRes.set(module.path, code)
}

/**
 * 转换成底层框架模板
 * @param {*} isComponent
 * @param {*} path
 * @param {*} components
 * @param {*} componentPlaceholder
 */
function toCompileTemplate(isComponent, path, components, componentPlaceholder) {
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
			content = `<wrapper>${content}</wrapper>`
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
	})

	// 处理 include 节点
	// 可以将目标文件除了 <template/> <wxs/> 外的整个代码引入，相当于是拷贝到 include 位置
	const includeNodes = $('include')
	includeNodes.each((_, elem) => {
		const src = $(elem).attr('src')
		// 将目标文件除了 <template/> <wxs/> 外的整个代码引入，相当于是拷贝到 include 位置
		if (src) {
			const includeContent = getContentByPath(getAbsolutePath(workPath, path, src)).trim()
			if (includeContent) {
				const $includeContent = cheerio.load(includeContent, {
					xmlMode: true,
					decodeEntities: false,
				})
				$includeContent('template').remove()
				$includeContent('wxs').remove()
				$includeContent('dds').remove()
				$(elem).html($includeContent.html())
			}
		}
	})

	// 处理 template 节点
	// https://developers.weixin.qq.com/miniprogram/dev/reference/wxml/template.html
	transTagTemplate($, templateModule, path, components, componentPlaceholder)

	// 处理 wxs 节点
	// https://developers.weixin.qq.com/miniprogram/dev/reference/wxs/01wxs-module.html
	transTagWxs($, scriptModule, path, workPath)

	// 处理 import 节点
	// https://developers.weixin.qq.com/miniprogram/dev/reference/wxml/import.html
	const importNodes = $('import')
	importNodes.each((_, elem) => {
		const src = $(elem).attr('src')
		if (src) {
			const importFullPath = getAbsolutePath(workPath, path, src)
			const importPath = importFullPath.replace(workPath).split('/').slice(0, -1).join('/')
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
					workPath,
				)
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
	const propsAry = getProps(attrs, tag)
	// 多 slot 支持，目前在组件定义时的选项中 multipleSlots 未生效
	// FIXME: 未处理 slot 值是动态的情况
	const multipleSlots = attrs?.slot
	if (attrs?.slot) {
		// 如果存在 if/else 属性，则需要转移到 template 中
		const withVIf = []
		const withoutVIf = []

		for (let i = 0; i < propsAry.length; i++) {
			const prop = propsAry[i]
			if (prop.includes('v-if') || prop.includes('v-else-if') || prop.includes('v-else')) {
				withVIf.push(prop)
			}
			else {
				withoutVIf.push(prop)
			}
		}
		if (isStart) {
			tagRes = `<template ${`${withVIf.join(' ')}`} #${multipleSlots}><${res}${` ${withoutVIf.join(' ')}`}>`
		}
		else {
			tagRes = `</${res}></template>`
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
 * 转换语法
 * @param {*} attrs
 */
function getProps(attrs, tag) {
	const attrsList = []
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
			let tranValue
			if (/\*this/.test(value)) {
				tranValue = JSON.stringify('item')
			}
			else if (/item/.test(value)) {
				// https://developers.weixin.qq.com/miniprogram/dev/reference/wxml/list.html#wx:key
				// 保留关键字 *this 代表在 for 循环中的 item 本身，这种表示需要 item 本身是一个唯一的字符串或者数字
				tranValue = getForItemName(attrs)
			}
			else {
				tranValue = parseKeyExpression(value, getForItemName(attrs))
			}
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
			|| ((name === 'x' || name === 'y') && tag === 'movable-view')) {
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
function parseKeyExpression(exp, itemName = 'item') {
	// 去除首尾空格
	exp = exp.trim()

	// 处理简单无表达式的情况
	if (!exp.includes('{{')) {
		return exp.startsWith(itemName) ? `'${exp}'` : `'${itemName}.${exp}'`
	}

	// 处理 '{{xxx}}' 的情况
	if (exp.startsWith('{{') && exp.endsWith('}}')) {
		const content = exp.slice(2, -2).trim()
		return content.startsWith(itemName) ? `'${content}'` : `'${itemName}.${content}'`
	}

	// 处理 '1-{{xxx}}' 的情况
	const parts = exp.split(/(\{\{.*?\}\})/)
	const result = parts.map((part) => {
		if (part.startsWith('{{') && part.endsWith('}}')) {
			const content = part.slice(2, -2).trim()
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

function transTagWxs($, scriptModule, path, workPath) {
	let wxsNodes = $('wxs')
	if (wxsNodes.length === 0) {
		wxsNodes = $('dds')
	}
	wxsNodes.each((_, elem) => {
		const smName = $(elem).attr('module')
		if (smName) {
			let wxsContent
			if (compileResCache.has(smName)) {
				wxsContent = compileResCache.get(smName)
			}
			else {
				const src = $(elem).attr('src')

				if (src) {
					wxsContent = getContentByPath(getAbsolutePath(workPath, path, src)).trim()
				}
				else {
					wxsContent = $(elem).html()
				}

				const wxsAst = babel.parseSync(wxsContent)
				traverse(wxsAst, {
					CallExpression(path) {
						// getRegExp -> new RegExp, getDate -> new Date
						if (path.node.callee.name === 'getRegExp' || path.node.callee.name === 'getDate') {
							const args = []
							for (let i = 0; i < path.node.arguments.length; i++) {
								args.push(path.node.arguments[i])
							}
							// 创建新的 NewExpression 节点
							const newExpr = types.newExpression(types.identifier(path.node.callee.name.substring(3)), args)
							// 替换原来的 CallExpression 节点
							path.replaceWith(newExpr)
						}
					},
				})
				wxsContent = babel.transformFromAstSync(wxsAst, '', {
					comments: false,
				}).code

				compileResCache.set(smName, wxsContent)
			}
			if (wxsContent) {
				scriptModule.push({
					path: smName,
					code: wxsContent,
				})
			}
		}
	})
	wxsNodes.remove()
}

function insertWxsAssignToRenderAst(ast, scriptModule, scriptRes) {
	for (const sm of scriptModule) {
		if (!scriptRes.has(sm.path)) {
			scriptRes.set(sm.path, sm.code)
		}
		const assignmentExpression = types.assignmentExpression(
			'=',
			// 创建赋值表达式
			types.memberExpression(
				types.identifier('_ctx'), // 对象标识符
				types.identifier(sm.path), // 属性标识符
				false, // 是否是计算属性
			),

			// 创建require调用表达式
			types.callExpression(
				types.identifier('require'), // 函数标识符
				[types.stringLiteral(sm.path)], // 参数列表，这里传入字符串字面量'foo'
			),
		)

		// 将这个赋值表达式包装在一个表达式语句中
		const expressionStatement = types.expressionStatement(assignmentExpression)

		ast.program.body[0].expression.body.body.unshift(expressionStatement)
	}
}

export {
	generateVModelTemplate,
	parseBraceExp,
	parseClassRules,
	parseKeyExpression,
	splitWithBraces,
}
export default compileML
