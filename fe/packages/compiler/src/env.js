import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { isObjectEmpty, uuid } from './common/utils.js'

let pathInfo = {}
let configInfo = {}

/**
 * 持久化编译过程的上下文
 */
function storeInfo(workPath) {
	storePathInfo(workPath)
	storeProjectConfig()
	storeAppConfig()
	storePageConfig()

	return {
		pathInfo,
		configInfo,
	}
}

function resetStoreInfo(opts) {
	pathInfo = opts.pathInfo
	configInfo = opts.configInfo
}

function storePathInfo(workPath) {
	pathInfo.workPath = workPath
	// 使用工作区目录或系统临时目录，确保有写入权限
	const tempDir = process.env.GITHUB_WORKSPACE || os.tmpdir()
	const targetDir = path.join(tempDir, `dimina-fe-dist-${Date.now()}`)

	// 确保目录存在
	if (!fs.existsSync(targetDir)) {
		fs.mkdirSync(targetDir, { recursive: true })
	}

	pathInfo.targetPath = targetDir
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

		if (configInfo.componentInfo[moduleId]) {
			continue
		}
		pageJsonContent.usingComponents[componentName] = moduleId

		const componentFilePath = path.resolve(getWorkPath(), `./${moduleId}.json`)
		if (!fs.existsSync(componentFilePath)) {
			continue
		}
		const cContent = parseContentByPath(componentFilePath)
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

		storeComponentConfig(configInfo.componentInfo[moduleId], componentFilePath)
	}
}

/**
 * 转化为相对小程序根目录的绝对路径，作为模块唯一性 id
 * @param {string} src
 */
function getModuleId(src, pageFilePath) {
	const lastIndex = pageFilePath.lastIndexOf('/')

	// 截取除最后一个斜杠之外的所有内容
	const newPath = pageFilePath.slice(0, lastIndex)
	const workPath = getWorkPath()
	const res = path.resolve(newPath, src)
	return res.replace(workPath, '')
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
	const { pages, subPackages = [] } = getAppConfigInfo()
	const pageInfo = getPageConfigInfo()
	const mainPages = pages.map(path => ({
		id: uuid(),
		path,
		usingComponents: pageInfo[path]?.usingComponents || {},
	}))

	const subPages = {}
	subPackages.forEach((subPkg) => {
		const rootPath = subPkg.root.endsWith('/') ? subPkg.root : `${subPkg.root}/`
		const independent = subPkg.independent ? subPkg.independent : false
		subPages[transSubDir(rootPath)] = {
			independent,
			info: subPkg.pages.map(path => ({
				id: uuid(),
				path: rootPath + path,
				usingComponents: pageInfo[rootPath + path]?.usingComponents || {},
			})),
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
	getPageConfigInfo,
	getPages,
	getProjectConfig,
	getTargetPath,
	getWorkPath,
	resetStoreInfo,
	storeInfo,
	storeProjectConfig,
}
