import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { resolveMiniProgramPath, toMiniProgramModuleId } from './common/path-utils.js'
import { isObjectEmpty, uuid } from './common/utils.js'
import { NpmResolver } from './common/npm-resolver.js'

let pathInfo = {}
let configInfo = {}
let npmResolver = null

// 小程序自定义文件类型：可扩展的文件扩展名和内联标签。
// 始终保留内置 wx/dd 类型；调用方通过 build() 或 storeInfo() 的 options.fileTypes 追加自定义项。
const DEFAULT_TEMPLATE_EXTS = ['.wxml', '.ddml']
const DEFAULT_STYLE_EXTS = ['.wxss', '.ddss', '.less', '.scss', '.sass']
const DEFAULT_VIEW_SCRIPT_EXTS = ['.wxs']
const DEFAULT_VIEW_SCRIPT_TAGS = ['wxs', 'dds']

// 保留扩展名：所有内置类型 + 逻辑(.js/.ts) + 配置(.json)。自定义项不得占用，
// 否则会跨角色串编（如 template:['js'] 会把页面逻辑文件当成模板解析）。
const RESERVED_EXTS = new Set([
	...DEFAULT_TEMPLATE_EXTS,
	...DEFAULT_STYLE_EXTS,
	...DEFAULT_VIEW_SCRIPT_EXTS,
	'.js',
	'.ts',
	'.json',
])

// 编译选项单例。env 会跨多次 build() 持久化；每次 storeInfo() 根据当前 options 重建，避免自定义文件类型串用。
let compilerOptions = normalizeFileTypes()

/**
 * 将单项规范化为扩展名：去除首尾空白、转小写并补一个前导点。
 * 仅接受字母、数字、连字符和下划线；空字符串、路径分隔符或其他元字符
 * 均返回 null，由调用方丢弃。扩展名会用于生成尾部匹配正则和查找文件，
 * 放行元字符可能导致误匹配。
 */
function normalizeExt(raw) {
	if (typeof raw !== 'string') {
		return null
	}
	const v = raw.trim().toLowerCase().replace(/^\.+/, '')
	if (!/^[a-z0-9_-]+$/.test(v)) {
		return null
	}
	return `.${v}`
}

/**
 * 将单项规范化为内联标签名：去除首尾空白、转小写并移除前导点。
 * 标签名会用于拼接 Cheerio 选择器（如 transTagWxs），因此必须以字母开头，
 * 且只能包含字母、数字、连字符和下划线。拒绝选择器元字符，避免 'qds,view'
 * 误选并删除 <view>，破坏编译产物。
 */
function normalizeTag(raw) {
	if (typeof raw !== 'string') {
		return null
	}
	const v = raw.trim().toLowerCase().replace(/^\.+/, '')
	if (!/^[a-z][a-z0-9_-]*$/.test(v)) {
		return null
	}
	return v
}

/**
 * 合并并去重内置项和自定义项；内置项在前，顺序即同名文件的查找优先级。
 * 传入 reserved 时，落在其中的自定义项被丢弃（防止占用其他角色/逻辑/配置的扩展名）。
 */
function mergeUnique(builtins, custom, normalizer, reserved) {
	const out = [...builtins]
	const seen = new Set(builtins)
	if (Array.isArray(custom)) {
		for (const raw of custom) {
			const n = normalizer(raw)
			if (n && !seen.has(n) && !reserved?.has(n)) {
				seen.add(n)
				out.push(n)
			}
		}
	}
	return out
}

/**
 * 根据 options.fileTypes 生成本次构建使用的自定义扩展名和标签。
 * viewScript 同时用于生成文件扩展名和内联标签。
 */
function normalizeFileTypes(fileTypes = {}) {
	const ft = fileTypes || {}
	return {
		templateExts: mergeUnique(DEFAULT_TEMPLATE_EXTS, ft.template, normalizeExt, RESERVED_EXTS),
		styleExts: mergeUnique(DEFAULT_STYLE_EXTS, ft.style, normalizeExt, RESERVED_EXTS),
		viewScriptExts: mergeUnique(DEFAULT_VIEW_SCRIPT_EXTS, ft.viewScript, normalizeExt, RESERVED_EXTS),
		viewScriptTags: mergeUnique(DEFAULT_VIEW_SCRIPT_TAGS, ft.viewScript, normalizeTag),
	}
}

/**
 * 持久化编译过程的上下文
 * @param {string} workPath 编译工作目录
 * @param {{ fileTypes?: { template?: string[], style?: string[], viewScript?: string[] } }} [options] 构建选项
 */
function storeInfo(workPath, options = {}) {
	storePathInfo(workPath)
	storeProjectConfig()
	storeAppConfig()
	storePageConfig()

	// 根据当前 options 重建，避免上一次 build() 注入的自定义文件类型影响本次构建。
	compilerOptions = normalizeFileTypes(options.fileTypes)

	return {
		pathInfo,
		configInfo,
		compilerOptions,
	}
}

function resetStoreInfo(opts) {
	pathInfo = opts.pathInfo
	configInfo = opts.configInfo
	// Worker 恢复上下文时使用主线程生成的自定义文件类型配置，缺省时回退到内置配置。
	compilerOptions = opts.compilerOptions || normalizeFileTypes()

	// 重新初始化 npm 解析器
	if (pathInfo.workPath) {
		npmResolver = new NpmResolver(pathInfo.workPath)
	}
}

function getTemplateExts() {
	return compilerOptions.templateExts
}

function getStyleExts() {
	return compilerOptions.styleExts
}

function getViewScriptExts() {
	return compilerOptions.viewScriptExts
}

function getViewScriptTags() {
	return compilerOptions.viewScriptTags
}

function storePathInfo(workPath) {
	pathInfo.workPath = workPath
	
	// 优先使用环境变量中的 TARGET_PATH
	if (process.env.TARGET_PATH) {
		pathInfo.targetPath = process.env.TARGET_PATH
	} else {
		// 使用工作区目录或系统临时目录，确保有写入权限
		const tempDir = process.env.GITHUB_WORKSPACE || os.tmpdir()
		const targetDir = path.join(tempDir, `dimina-fe-dist-${Date.now()}`)

		// 确保目录存在
		if (!fs.existsSync(targetDir)) {
			fs.mkdirSync(targetDir, { recursive: true })
		}

		pathInfo.targetPath = targetDir
	}
	
	// 初始化 npm 解析器
	npmResolver = new NpmResolver(workPath)
}

function storeProjectConfig() {
	const privateConfigPath = `${pathInfo.workPath}/project.private.config.json`
	const defaultConfigPath = `${pathInfo.workPath}/project.config.json`

	let privateConfig = {}
	let defaultConfig = {}

	// Load default config if exists
	if (fs.existsSync(defaultConfigPath)) {
		try {
			defaultConfig = parseContentByPath(defaultConfigPath)
		}
		catch (e) {
			console.warn('Failed to parse project.config.json:', e.message)
		}
	}

	// Load private config if exists
	if (fs.existsSync(privateConfigPath)) {
		try {
			privateConfig = parseContentByPath(privateConfigPath)
		}
		catch (e) {
			console.warn('Failed to parse project.private.config.json:', e.message)
		}
	}

	// Merge configs with private config taking precedence
	configInfo.projectInfo = { ...defaultConfig, ...privateConfig }
}

function getProjectConfig() {
	return configInfo.projectInfo
}

function storeAppConfig() {
	const filePath = `${pathInfo.workPath}/app.json`
	const content = parseContentByPath(filePath)
	const newObj = {}
	for (const key in content) {
		if (Object.prototype.hasOwnProperty.call(content, key)) {
			// 兼容 subpackages / subPackages
			if (key === 'subpackages') {
				// 将值复制到新对象中，使用新的键名
				newObj.subPackages = content[key]
			}
			else {
				// 对于其他类型的值，直接复制到新对象中
				newObj[key] = content[key]
			}
		}
	}
	configInfo.appInfo = newObj
}

function getContentByPath(path) {
	return fs.readFileSync(path, { encoding: 'utf-8' })
}

function parseContentByPath(path) {
	return JSON.parse(getContentByPath(path))
}

/**
 * 收集页面 json 信息
 */
function storePageConfig() {
	const { pages, subPackages } = configInfo.appInfo
	configInfo.pageInfo = {}
	configInfo.componentInfo = {}

	// 首先处理 app.json 中的全局 usingComponents
	if (configInfo.appInfo.usingComponents) {
		const appFilePath = `${pathInfo.workPath}/app.json`
		storeComponentConfig(configInfo.appInfo, appFilePath)
	}

	collectionPageJson(pages)

	// 处理分包信息
	// https://developers.weixin.qq.com/miniprogram/dev/framework/subpackages/basic.html
	if (subPackages) {
		subPackages.forEach((subPkg) => {
			collectionPageJson(subPkg.pages, subPkg.root)
		})
	}
}

/**
 * 匹配页面和对应的配置信息
 * @param {*} pages
 */
function collectionPageJson(pages, root) {
	pages.forEach((pagePath) => {
		let np = pagePath
		if (root) {
			if (!root.endsWith('/')) {
				root += '/'
			}
			np = root + np
		}
		const pageFilePath = `${pathInfo.workPath}/${np}.json`
		if (fs.existsSync(pageFilePath)) {
			const pageJsonContent = parseContentByPath(pageFilePath)
			if (root) {
				pageJsonContent.root = transSubDir(root)
			}
			configInfo.pageInfo[np] = pageJsonContent

			// 递归解析自定义组件
			storeComponentConfig(pageJsonContent, pageFilePath)
		}
	})
}

/**
 * 按页面收集组件 json 信息
 * @param {*} pageJsonContent
 * @param {*} pageFilePath
 */
function storeComponentConfig(pageJsonContent, pageFilePath) {
	if (isObjectEmpty(pageJsonContent.usingComponents)) {
		return
	}
	// 解析当前页面的自定义组件信息
	for (const [componentName, componentPath] of Object.entries(pageJsonContent.usingComponents)) {
		const moduleId = getModuleId(componentPath, pageFilePath)
		pageJsonContent.usingComponents[componentName] = moduleId

		if (configInfo.componentInfo[moduleId]) {
			continue
		}

		// 尝试查找组件配置文件
		let componentFilePath = path.resolve(getWorkPath(), `./${moduleId}.json`)
		let cContent = null
		
		if (fs.existsSync(componentFilePath)) {
			cContent = parseContentByPath(componentFilePath)
		} else {
			// 对于 npm 组件，尝试查找 index.json
			const indexJsonPath = path.resolve(getWorkPath(), `./${moduleId}/index.json`)
			if (fs.existsSync(indexJsonPath)) {
				componentFilePath = indexJsonPath
				cContent = parseContentByPath(componentFilePath)
			} else {
				// 如果是 npm 组件，创建一个默认的组件配置
				if (moduleId.includes('/miniprogram_npm/')) {
					console.log(`[env] 为 npm 组件创建默认配置: ${moduleId}`)
					cContent = {
						component: true,
						usingComponents: {}
					}
				} else {
					console.warn(`[env] 组件配置文件不存在: ${componentFilePath}`)
					continue
				}
			}
		}
		
		const cUsing = cContent.usingComponents || {}
		const isComponent = cContent.component || false
		const cComponents = Object.keys(cUsing).reduce((acc, key) => {
			acc[key] = getModuleId(cUsing[key], componentFilePath)
			return acc
		}, {})

		configInfo.componentInfo[moduleId] = {
			id: uuid(),
			path: moduleId,
			component: isComponent,
			usingComponents: cComponents,
		}

		// 只有当配置文件存在时才递归处理
		if (cContent.usingComponents && Object.keys(cContent.usingComponents).length > 0) {
			storeComponentConfig(configInfo.componentInfo[moduleId], componentFilePath)
		}
	}
}

/**
 * 转化为相对小程序根目录的绝对路径，作为模块唯一性 id
 * 支持 npm 组件解析
 * @param {string} src
 */
function getModuleId(src, pageFilePath) {
	const resolvedAlias = resolveAppAlias(src)
	if (resolvedAlias) {
		return resolvedAlias
	}

	if (!npmResolver) {
		// 如果 npm 解析器未初始化，使用原有逻辑
		const workPath = getWorkPath()
		return toMiniProgramModuleId(
			resolveMiniProgramPath(workPath, pageFilePath, src),
			workPath,
		)
	}

	// 使用 npm 解析器处理组件路径
	return npmResolver.resolveComponentPath(src, pageFilePath)
}

function resolveAppAlias(src) {
	const resolveAlias = configInfo.appInfo?.resolveAlias
	if (!resolveAlias || typeof src !== 'string') {
		return null
	}

	for (const [alias, target] of Object.entries(resolveAlias)) {
		if (alias.endsWith('/*') && target.endsWith('/*')) {
			const aliasPrefix = alias.slice(0, -1)
			const targetPrefix = target.slice(0, -1)
			if (src.startsWith(aliasPrefix)) {
				return src.replace(aliasPrefix, targetPrefix)
			}
		}
		else if (src === alias) {
			return target
		}
	}

	return null
}

function getTargetPath() {
	return pathInfo.targetPath
}

function getComponent(src) {
	return configInfo.componentInfo[src]
}

function getPageConfigInfo() {
	return configInfo.pageInfo
}

function getAppConfigInfo() {
	return configInfo.appInfo
}

function getWorkPath() {
	return pathInfo.workPath
}

function getNpmResolver() {
	return npmResolver
}

function getAppId() {
	return configInfo.projectInfo.appid
}

function getAppName() {
	if (configInfo.projectInfo.projectname) {
		return decodeURIComponent(configInfo.projectInfo.projectname)
	}
	return getAppId()
}

function transSubDir(name) {
	// 去除尾部的斜杠，并在前面添加 'sub_'
	return `sub_${name.replace(/\/$/, '')}`
}

/**
 * 获取页面及其配置信息，并生成id（输出的 json 文件没有 id)
 */
function getPages() {
	// 获取所有页面路径
	const { pages, subPackages = [], usingComponents: globalComponents = {} } = getAppConfigInfo()
	const pageInfo = getPageConfigInfo()
	
	const mainPages = pages.map(path => {
		const pageComponents = pageInfo[path]?.usingComponents || {}
		// 合并全局组件和页面组件，页面组件优先级更高
		const mergedComponents = { ...globalComponents, ...pageComponents }
		
		return {
			id: uuid(),
			path,
			usingComponents: mergedComponents,
		}
	})

	const subPages = {}
	subPackages.forEach((subPkg) => {
		const rootPath = subPkg.root.endsWith('/') ? subPkg.root : `${subPkg.root}/`
		const independent = subPkg.independent ? subPkg.independent : false
		subPages[transSubDir(rootPath)] = {
			independent,
			info: subPkg.pages.map(path => {
				const fullPath = rootPath + path
				const pageComponents = pageInfo[fullPath]?.usingComponents || {}
				// 合并全局组件和页面组件，页面组件优先级更高
				const mergedComponents = { ...globalComponents, ...pageComponents }
				
				return {
					id: uuid(),
					path: fullPath,
					usingComponents: mergedComponents,
				}
			}),
		}
	})
	return {
		mainPages,
		subPages,
	}
}

export {
	getAppConfigInfo,
	getAppId,
	getAppName,
	getComponent,
	getContentByPath,
	getNpmResolver,
	getPageConfigInfo,
	getPages,
	getProjectConfig,
	getStyleExts,
	getTargetPath,
	getTemplateExts,
	getViewScriptExts,
	getViewScriptTags,
	getWorkPath,
	resetStoreInfo,
	resolveAppAlias,
	storeInfo,
	storeProjectConfig,
}
