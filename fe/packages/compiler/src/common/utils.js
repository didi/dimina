import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import artCode from './art.js'

function hasCompileInfo(modulePath, list, preList) {
	for (const element of list) {
		if (element.path === modulePath) {
			return true
		}
	}
	if (!Array.isArray(preList)) {
		return false
	}
	for (const element of preList) {
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
const copiedAssetGroups = new Set()
const collectableImageAssetPattern = /\.(?:png|jpe?g|gif|svg|webp|heic|heif)$/i

function splitAssetReference(src) {
	const suffixIndex = src.search(/[?#]/)
	return suffixIndex === -1
		? { sourcePath: src, suffix: '' }
		: { sourcePath: src.slice(0, suffixIndex), suffix: src.slice(suffixIndex) }
}

function resetAssetCache() {
	for (const assetPath of Object.keys(assetsMap)) {
		delete assetsMap[assetPath]
	}
	copiedAssetGroups.clear()
}

function isCollectableImageAsset(src) {
	return typeof src === 'string' && collectableImageAssetPattern.test(splitAssetReference(src).sourcePath)
}

function isPathInside(rootPath, targetPath) {
	const relativePath = path.relative(rootPath, targetPath)
	return relativePath === '' || (!relativePath.startsWith(`..${path.sep}`) && relativePath !== '..' && !path.isAbsolute(relativePath))
}

function resolveAssetSourcePath(workPath, pagePath, src) {
	const projectRoot = path.resolve(workPath)
	if (src.startsWith('/')) {
		return path.resolve(projectRoot, `.${src}`)
	}

	const normalizedPagePath = path.resolve(pagePath)
	const pageDirectory = path.isAbsolute(pagePath) && isPathInside(projectRoot, normalizedPagePath)
		? path.dirname(normalizedPagePath)
		: path.resolve(projectRoot, path.dirname(pagePath.replace(/^[/\\]+/, '')))
	const resolvedPath = path.resolve(pageDirectory, src)
	if (isPathInside(projectRoot, resolvedPath)) {
		return resolvedPath
	}

	// Mini-program resources cannot escape the project package. Some imported
	// templates use enough ../ segments for their consuming page rather than the
	// template file itself, so clamp that traversal at the project root.
	return path.resolve(projectRoot, src.replace(/^(?:\.\.[/\\])+/, ''))
}

/**
 * 将静态资源存储到 static 文件夹
 */
function collectAssets(workPath, pagePath, src, targetPath, appId) {
	if (src.startsWith('http') || src.startsWith('//')) {
		// TODO: 处理网络地址的资源，提取地址后加入 dns-fetch
		// 不处理网络图片
		return src
	}

	if (!isCollectableImageAsset(src)) {
		return src
	}

	const { sourcePath, suffix } = splitAssetReference(src)
	const absolutePath = resolveAssetSourcePath(workPath, pagePath, sourcePath)
	// 同一源文件可以被并发发布到不同目录；缓存必须包含目标目录，不能只按源路径复用。
	const cacheKey = `${path.resolve(targetPath)}\0${absolutePath}`

	if (assetsMap[cacheKey]) {
		return `${assetsMap[cacheKey]}${suffix}`
	}

	try {
		// 复制将文件夹下所有同类型的资源文件并加上前缀
		const ext = path.extname(sourcePath)
		const dirPath = absolutePath.split(path.sep).slice(0, -1).join('/')
		const prefix = uuid(dirPath)

		const targetStatic = `${targetPath}/main/static`
		if (!fs.existsSync(targetStatic)) {
			fs.mkdirSync(targetStatic, { recursive: true })
		}

		const pathPrefix = process.env.ASSETS_PATH_PREFIX ? '' : '/'
		const groupKey = `${path.resolve(targetPath)}\0${dirPath}\0${ext}`
		if (!copiedAssetGroups.has(groupKey)) {
			for (const file of getFilesWithExtension(dirPath, ext)) {
				const sourceFile = path.resolve(dirPath, file)
				fs.copyFileSync(sourceFile, `${targetStatic}/${prefix}_${file}`)
				assetsMap[`${path.resolve(targetPath)}\0${sourceFile}`]
					= `${pathPrefix}${appId}/main/static/${prefix}_${file}`
			}
			copiedAssetGroups.add(groupKey)
		}
	}
	catch (error) {
		console.log(error)
	}
	return assetsMap[cacheKey] ? `${assetsMap[cacheKey]}${suffix}` : src
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
		const viewportWidth = Number((Number(pixel) / 7.5).toFixed(6))
		return `${Object.is(viewportWidth, -0) ? 0 : viewportWidth}vw`
	})
}

// Deterministic per-path id: the first 64 bits of sha256(path) as a base36
// token. Determinism is load-bearing — the view/style/render stages each hash
// the path independently in separate worker realms, so a random id would
// diverge and break WXSS scoping. 64 bits keeps near-identical component paths
// (the mini-program norm) collision-free where a 32-bit hash would clash.
function uuid(str) {
	return crypto.createHash('sha256').update(str).digest().readBigUInt64BE(0).toString(36)
}

const tagWhiteList = [
	'page',
	'component-host',
	'block',
	'button',
	'camera',
	'canvas',
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

// Known mini-program built-ins are tracked separately from ordinary HTML tags.
// This lets compatibility diagnostics keep warning for an unimplemented
// built-in such as <ad> or <audio>, while the view compiler follows glass-easel
// and leaves undeclared tags as native elements.
const miniProgramBuiltinTags = new Set([
	...tagWhiteList,
	'match-media',
	'page-container',
	'share-element',
	'editor',
	'audio',
	'channel-live',
	'channel-video',
	'live-player',
	'live-pusher',
	'voip-room',
	'ad',
	'ad-custom',
	'official-account',
	'xr-frame',
])

export {
	artCode,
	collectAssets,
	filterFilesByRegex,
	getAbsolutePath,
	hasCompileInfo,
	isCollectableImageAsset,
	isObjectEmpty,
	miniProgramBuiltinTags,
	resolveAssetSourcePath,
	resetAssetCache,
	tagWhiteList,
	transformRpx,
	uuid,
}
