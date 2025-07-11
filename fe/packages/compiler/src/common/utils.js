import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import artCode from './art.js'

function hasCompileInfo(modulePath, list, preList) {
	const mergeList = Array.isArray(preList) ? [...preList, ...list] : list
	for (const element of mergeList) {
		if (element.path === modulePath) {
			return true
		}
	}
	return false
}

function getAbsolutePath(workPath, pagePath, src) {
	// 如果是绝对路径，直接拼接工作路径
	if (src.startsWith('/')) {
		return path.join(workPath, src)
	}
	
	// 检查是否是 npm 组件路径
	if (pagePath.includes('/miniprogram_npm/')) {
		// 对于 npm 组件，需要特殊处理相对路径
		// pagePath 格式: /miniprogram_npm/@lib/radio-group/index
		// src 格式: ../template/item.wxml 或 ./index.wxml
		
		// 获取组件所在目录的完整路径
		const componentDir = pagePath.split('/').slice(0, -1).join('/')
		const componentFullPath = workPath + componentDir
		
		// 使用 Node.js path.resolve 来正确解析相对路径
		return path.resolve(componentFullPath, src)
	}
	
	// 对于普通组件，使用原有逻辑
	const relativePath = pagePath.split('/').filter(part => part !== '').slice(0, -1).join('/')
	return path.resolve(workPath, relativePath, src)
}

const assetsMap = {}
/**
 * 将静态资源存储到 static 文件夹
 */
function collectAssets(workPath, pagePath, src, targetPath, appId) {
	if (src.startsWith('http') || src.startsWith('//')) {
		// TODO: 处理网络地址的资源，提取地址后加入 dns-fetch
		// 不处理网络图片
		return src
	}

	if (!/\.(?:png|jpe?g|gif|svg)(?:\?.*)?$/.test(src)) {
		return src
	}

	// example/article/article -> example/article
	const relativePath = pagePath.split('/').slice(0, -1).join('/')
	const absolutePath = src.startsWith('/')
		? (workPath + src)
		: path.resolve(workPath, relativePath, src)

	if (assetsMap[absolutePath]) {
		return assetsMap[absolutePath]
	}

	try {
		// 复制将文件夹下所有同类型的资源文件并加上前缀
		const ext = `.${src.split('.').pop()}`
		const dirPath = absolutePath.split(path.sep).slice(0, -1).join('/')
		const prefix = uuid()

		const targetStatic = `${targetPath}/main/static`
		if (!fs.existsSync(targetStatic)) {
			fs.mkdirSync(targetStatic, { recursive: true })
		}

		getFilesWithExtension(dirPath, ext).forEach((file) => {
			fs.copyFileSync(path.resolve(dirPath, file), `${targetStatic}/${prefix}_${file}`)
		})

		const filename = src.split('/').pop()
		const pathPrefix = process.env.ASSETS_PATH_PREFIX ? '' : '/'
		assetsMap[absolutePath] = `${pathPrefix}${appId}/main/static/${prefix}_${filename}`
	}
	catch (error) {
		console.log(error)
	}
	return assetsMap[absolutePath] || src
}

function getFilesWithExtension(directory, extension) {
	const files = fs.readdirSync(directory)
	const filteredFiles = files.filter(file => path.extname(file) === extension)
	return filteredFiles
}

function filterFilesByRegex(directoryPath, regex) {
	try {
		// 读取文件夹中的文件
		const files = fs.readdirSync(directoryPath)

		// 过滤匹配的文件
		const matchingFiles = files.filter((file) => {
			const filePath = path.join(directoryPath, file)
			const stat = fs.statSync(filePath) // 获取文件状态

			return stat.isFile() && regex.test(file) // 检查是否为文件并且匹配正则表达式
		})

		// 输出匹配的文件名

		return matchingFiles
	}
	catch (err) {
		console.error('无法读取文件夹:', err)
	}
}

function isObjectEmpty(objectName) {
	if (!objectName) {
		return true
	}
	return (
		Object.keys(objectName).length === 0
		&& objectName.constructor === Object
	)
}

function isString(o) {
	return Object.prototype.toString.call(o) === '[object String]'
}

function transformRpx(styleText) {
	if (!isString(styleText)) {
		return styleText
	}

	return styleText.replace(/([+-]?\d+(?:\.\d+)?)rpx/g, (_, pixel) => {
		return `${Number(pixel)}rem`
	})
}

function uuid() {
	return Math.random().toString(36).slice(2, 7)
}

const tagWhiteList = [
	'page',
	'wrapper',
	'block',
	'button',
	'camera',
	'checkbox-group',
	'checkbox',
	'cover-image',
	'cover-view',
	'form',
	'icon',
	'image',
	'input',
	'keyboard-accessory',
	'label',
	'map',
	'movable-area',
	'movable-view',
	'navigation-bar',
	'navigator',
	'open-data',
	'page-meta',
	'picker-view-column',
	'picker-view',
	'picker',
	'progress',
	'radio-group',
	'radio',
	'rich-text',
	'root-portal',
	'scroll-view',
	'slider',
	'swiper-item',
	'swiper',
	'switch',
	'template',
	'text',
	'textarea',
	'video',
	'view',
	'web-view',
]

export {
	artCode,
	collectAssets,
	filterFilesByRegex,
	getAbsolutePath,
	hasCompileInfo,
	isObjectEmpty,
	tagWhiteList,
	transformRpx,
	uuid,
}
