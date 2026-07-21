import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { parseSync } from 'oxc-parser'
import { walk } from 'oxc-walker'
import { resolveMiniProgramPath, toMiniProgramModuleId } from './common/path-utils.js'
import { isObjectEmpty, resolveAssetSourcePath, uuid } from './common/utils.js'
import { NpmResolver } from './common/npm-resolver.js'
import { DependencyGraph } from './common/dependency-graph.js'

let pathInfo = {}
let configInfo = {}
let npmResolver = null
let dependencyGraph = new DependencyGraph()

// 小程序自定义文件类型：可扩展的文件扩展名和内联标签。
// 始终保留内置 wx/dd 类型；调用方通过 build() 或 storeInfo() 的 options.fileTypes 追加自定义项。
const DEFAULT_TEMPLATE_EXTS = ['.wxml', '.ddml']
// 保留已有的微信、钉钉与支付宝指令前缀兼容；自定义模板类型会再显式派生前缀。
const DEFAULT_TEMPLATE_DIRECTIVE_PREFIXES = ['wx', 'dd', 'a']
const DEFAULT_STYLE_EXTS = ['.wxss', '.ddss', '.less', '.scss', '.sass']
const DEFAULT_VIEW_SCRIPT_EXTS = ['.wxs']
const DEFAULT_VIEW_SCRIPT_TAGS = ['wxs', 'dds']
// 微信自定义 tabBar 的规范入口只在编译适配层解析；运行时通过产物元数据识别。
const CUSTOM_TAB_BAR_COMPONENT_PATH = '/custom-tab-bar/index'
const STYLE_ISOLATION_VALUES = new Set([
	'isolated',
	'apply-shared',
	'shared',
])

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
	const templateExts = mergeUnique(DEFAULT_TEMPLATE_EXTS, ft.template, normalizeExt, RESERVED_EXTS)
	return {
		templateExts,
		templateDirectivePrefixes: [...new Set([...DEFAULT_TEMPLATE_DIRECTIVE_PREFIXES, ...templateExts.map((extension) => {
			const name = extension.slice(1)
			return name.endsWith('ml') ? name.slice(0, -2) : name
		}).filter(Boolean)])],
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
	// 依赖图需要知道当前构建的文件类型，因此在扫描项目前先重建选项。
	compilerOptions = normalizeFileTypes(options.fileTypes)
	storePathInfo(workPath)
	storeProjectConfig()
	storeAppConfig()
	storePageConfig()
	dependencyGraph = createInitialDependencyGraph()
	dependencyGraph.merge(options.dependencyGraph)

	return {
		pathInfo,
		configInfo,
		compilerOptions,
		dependencyGraph: dependencyGraph.toJSON(),
	}
}

function resetStoreInfo(opts) {
	pathInfo = opts.pathInfo
	configInfo = opts.configInfo
	// Worker 恢复上下文时使用主线程生成的自定义文件类型配置，缺省时回退到内置配置。
	compilerOptions = opts.compilerOptions || normalizeFileTypes()
	dependencyGraph = new DependencyGraph(opts.dependencyGraph)

	// 重新初始化 npm 解析器
	if (pathInfo.workPath) {
		npmResolver = new NpmResolver(pathInfo.workPath)
	}
}

function getTemplateExts() {
	return compilerOptions.templateExts
}

function getTemplateDirectivePrefixes() {
	return compilerOptions.templateDirectivePrefixes
		|| normalizeFileTypes({ template: compilerOptions.templateExts }).templateDirectivePrefixes
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

function getDependencyGraph() {
	return dependencyGraph
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

	storeCustomTabBarConfig()
}

/**
 * 微信会把 custom-tab-bar/index 作为每个 tab 页的直属组件创建。业务页面
 * 不需要在 usingComponents 中显式声明它，因此编译阶段补一个内部组件引用，
 * 让逻辑、视图和样式三个编译器都能沿现有依赖图收集该组件。
 */
function storeCustomTabBarConfig() {
	const tabBar = configInfo.appInfo?.tabBar
	if (tabBar?.custom !== true || !Array.isArray(tabBar.list)) {
		return
	}

	const componentJsonPath = path.join(pathInfo.workPath, 'custom-tab-bar/index.json')
	if (!fs.existsSync(componentJsonPath)) {
		console.warn('[env] tabBar.custom 已启用，但找不到 custom-tab-bar/index.json')
		return
	}

	const dependencyName = `dimina-${uuid(CUSTOM_TAB_BAR_COMPONENT_PATH)}`
	const internalConfig = {
		usingComponents: {
			[dependencyName]: CUSTOM_TAB_BAR_COMPONENT_PATH,
		},
	}
	storeComponentConfig(internalConfig, path.join(pathInfo.workPath, 'app.json'))
	const componentConfig = configInfo.componentInfo[CUSTOM_TAB_BAR_COMPONENT_PATH]
	if (componentConfig) {
		componentConfig.customTabBar = true
	}

	for (const item of tabBar.list) {
		const pagePath = typeof item?.pagePath === 'string'
			? item.pagePath.replace(/^\/+/, '')
			: ''
		if (!pagePath || !configInfo.appInfo.pages?.includes(pagePath)) {
			continue
		}
		const pageConfig = configInfo.pageInfo[pagePath] ||= {}
		pageConfig.usingComponents ||= {}
		const declaredComponents = {
			...(configInfo.appInfo.usingComponents || {}),
			...pageConfig.usingComponents,
		}
		const declaredEntry = Object.entries(declaredComponents)
			.find(([, componentPath]) => componentPath === CUSTOM_TAB_BAR_COMPONENT_PATH)
		let componentName = declaredEntry?.[0] || dependencyName
		let suffix = 0
		while (
			declaredComponents[componentName]
			&& declaredComponents[componentName] !== CUSTOM_TAB_BAR_COMPONENT_PATH
		) {
			suffix++
			componentName = `${dependencyName}-${suffix}`
		}
		pageConfig.usingComponents[componentName] = CUSTOM_TAB_BAR_COMPONENT_PATH
		pageConfig.customTabBar = { componentName }
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
		const styleIsolation = resolveComponentStyleIsolation(cContent, componentFilePath)
		const cComponents = Object.keys(cUsing).reduce((acc, key) => {
			acc[key] = getModuleId(cUsing[key], componentFilePath)
			return acc
		}, {})

		configInfo.componentInfo[moduleId] = {
			id: uuid(moduleId),
			path: moduleId,
			component: isComponent,
			styleIsolation,
			usingComponents: cComponents,
			componentPlaceholder: { ...(cContent.componentPlaceholder || {}) },
		}

		// 只有当配置文件存在时才递归处理
		if (cContent.usingComponents && Object.keys(cContent.usingComponents).length > 0) {
			storeComponentConfig(configInfo.componentInfo[moduleId], componentFilePath)
		}
	}
}

function getStaticProperty(objectExpression, propertyName) {
	if (objectExpression?.type !== 'ObjectExpression') {
		return undefined
	}
	return objectExpression.properties?.find((property) => {
		if (property.type !== 'Property' || property.computed) {
			return false
		}
		return property.key?.name === propertyName || property.key?.value === propertyName
	})?.value
}

function normalizeStyleIsolation(value) {
	return STYLE_ISOLATION_VALUES.has(value) ? value : undefined
}

/**
 * styleIsolation can be declared either in component.json or in
 * Component({ options }). The style compiler must know it before service
 * runtime starts, so only statically-declared literal options participate.
 * addGlobalClass is the legacy equivalent of apply-shared.
 */
function resolveComponentStyleIsolation(componentConfig, componentJsonPath) {
	const jsonValue = normalizeStyleIsolation(componentConfig?.styleIsolation)
	if (jsonValue) {
		return jsonValue
	}

	const basePath = componentJsonPath.replace(/\.json$/i, '')
	const scriptPath = ['.js', '.ts']
		.map(ext => `${basePath}${ext}`)
		.find(candidate => fs.existsSync(candidate))
	if (!scriptPath) {
		return 'isolated'
	}

	try {
		const source = getContentByPath(scriptPath)
		const { program } = parseSync(scriptPath, source, {
			sourceType: 'unambiguous',
		})
		let extractedValue
		walk(program, {
			enter(expression) {
				if (extractedValue) {
					return
				}
				if (
					expression?.type !== 'CallExpression'
					|| expression.callee?.type !== 'Identifier'
					|| expression.callee.name !== 'Component'
				) {
					return
				}
				const definition = expression.arguments?.[0]
				const options = getStaticProperty(definition, 'options')
				const styleIsolation = getStaticProperty(options, 'styleIsolation')?.value
				const normalized = normalizeStyleIsolation(styleIsolation)
				if (normalized) {
					extractedValue = normalized
					return
				}
				if (getStaticProperty(options, 'addGlobalClass')?.value === true) {
					extractedValue = 'apply-shared'
				}
			},
		})
		if (extractedValue) {
			return extractedValue
		}
	}
	catch (error) {
		console.warn(`[env] 无法解析组件样式隔离配置 ${scriptPath}: ${error.message}`)
	}

	return 'isolated'
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
			id: uuid(path),
			path,
			appStyleScopeId: getAppStyleScopeId(),
			sharedStyleScopeIds: collectSharedStyleScopeIds(mergedComponents),
			usingComponents: mergedComponents,
			componentPlaceholder: { ...(pageInfo[path]?.componentPlaceholder || {}) },
			customTabBar: pageInfo[path]?.customTabBar,
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
					id: uuid(fullPath),
					path: fullPath,
					appStyleScopeId: getAppStyleScopeId(),
					sharedStyleScopeIds: collectSharedStyleScopeIds(mergedComponents),
					usingComponents: mergedComponents,
					componentPlaceholder: { ...(pageInfo[fullPath]?.componentPlaceholder || {}) },
					customTabBar: pageInfo[fullPath]?.customTabBar,
				}
			}),
		}
	})
	return {
		mainPages,
		subPages,
	}
}

function addExistingModuleFiles(graph, moduleId) {
	const relativeId = moduleId.replace(/^\/+/, '')
	const basePath = path.resolve(getWorkPath(), relativeId)
	const baseCandidates = [basePath, path.join(basePath, 'index')]
	const extensions = [
		'.json',
		'.js',
		'.ts',
		...getTemplateExts(),
		...getStyleExts(),
		...getViewScriptExts(),
	]
	for (const candidateBase of baseCandidates) {
		for (const extension of extensions) {
			const filePath = `${candidateBase}${extension}`
			if (fs.existsSync(filePath)) {
				graph.addFile(moduleId, filePath, getFileDependencyKind(filePath))
			}
		}
	}
}

function getFileDependencyKind(filePath) {
	const extension = path.extname(filePath).toLowerCase()
	if (extension === '.json') return 'config'
	if (extension === '.js' || extension === '.ts') return 'logic'
	if (getTemplateExts().includes(extension) || getViewScriptExts().includes(extension)) return 'view'
	if (getStyleExts().includes(extension)) return 'style'
	return 'module'
}

function createInitialDependencyGraph() {
	const graph = new DependencyGraph()
	graph.addNode('app', { type: 'app' })
	for (const fileName of [
		'app.json',
		'app.js',
		'app.ts',
		'project.config.json',
		'project.private.config.json',
	]) {
		const filePath = path.resolve(getWorkPath(), fileName)
		if (fs.existsSync(filePath)) {
			graph.addFile('app', filePath, getFileDependencyKind(filePath))
		}
	}
	addExistingModuleFiles(graph, 'app')
	for (const item of getAppConfigInfo().tabBar?.list || []) {
		for (const field of ['iconPath', 'selectedIconPath']) {
			if (!item[field]) continue
			const assetPath = resolveAssetSourcePath(getWorkPath(), '', item[field])
			if (fs.existsSync(assetPath)) {
				graph.addFile('app', assetPath, 'config')
			}
		}
	}

	for (const component of Object.values(configInfo.componentInfo || {})) {
		graph.addNode(component.path, { type: 'component' })
		addExistingModuleFiles(graph, component.path)
	}
	for (const component of Object.values(configInfo.componentInfo || {})) {
		for (const dependencyPath of Object.values(component.usingComponents || {})) {
			graph.addDependency(component.path, dependencyPath, 'component')
		}
	}

	const pages = getPages()
	const addEntry = (page, packageRoot) => {
		graph.addNode(page.path, {
			type: 'page',
			entry: true,
			packageRoot,
		})
		addExistingModuleFiles(graph, page.path)
		graph.addDependency(page.path, 'app', 'app')
		for (const dependencyPath of Object.values(page.usingComponents || {})) {
			graph.addDependency(page.path, dependencyPath, 'component')
		}
	}
	for (const page of pages.mainPages) {
		addEntry(page, null)
	}
	for (const [packageRoot, subPackage] of Object.entries(pages.subPages)) {
		for (const page of subPackage.info) {
			addEntry(page, packageRoot)
		}
	}
	return graph
}

function collectSharedStyleScopeIds(usingComponents) {
	const result = []
	const visited = new Set()
	const visit = (componentPath) => {
		if (visited.has(componentPath)) {
			return
		}
		visited.add(componentPath)
		const component = configInfo.componentInfo[componentPath]
		if (!component) {
			return
		}
		if (component.styleIsolation === 'shared') {
			result.push(component.id)
		}
		for (const childPath of Object.values(component.usingComponents || {})) {
			visit(childPath)
		}
	}
	for (const componentPath of Object.values(usingComponents || {})) {
		visit(componentPath)
	}
	return result
}

function getAppStyleScopeId() {
	return uuid('app')
}

export {
	getAppConfigInfo,
	getDependencyGraph,
	getAppId,
	getAppName,
	getAppStyleScopeId,
	getComponent,
	getContentByPath,
	getNpmResolver,
	getPageConfigInfo,
	getPages,
	getProjectConfig,
	getStyleExts,
	getTargetPath,
	getTemplateDirectivePrefixes,
	getTemplateExts,
	getViewScriptExts,
	getViewScriptTags,
	getWorkPath,
	resetStoreInfo,
	resolveAppAlias,
	storeInfo,
	storeProjectConfig,
}
