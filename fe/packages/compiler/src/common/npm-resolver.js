import fs from 'node:fs'
import path from 'node:path'

/**
 * npm 组件解析器
 * 根据微信小程序 npm 支持规范实现组件寻址
 * https://developers.weixin.qq.com/miniprogram/dev/devtools/npm.html
 */
class NpmResolver {
	constructor(workPath) {
		this.workPath = workPath
		this.miniprogramNpmCache = new Map()
		this.packageCache = new Map()
	}

	/**
	 * 解析组件路径，支持 npm 包组件
	 * @param {string} componentPath 组件路径
	 * @param {string} pageFilePath 页面文件路径
	 * @returns {string} 解析后的组件路径
	 */
	resolveComponentPath(componentPath, pageFilePath) {
		// 如果是相对路径，直接返回
		if (componentPath.startsWith('./') || componentPath.startsWith('../') || componentPath.startsWith('/')) {
			return this.resolveRelativePath(componentPath, pageFilePath)
		}

		// 尝试解析为 npm 包组件
		const npmPath = this.resolveNpmComponent(componentPath, pageFilePath)
		if (npmPath) {
			return npmPath
		}

		// 如果都找不到，返回原路径
		return this.resolveRelativePath(componentPath, pageFilePath)
	}

	/**
	 * 解析相对路径组件
	 * @param {string} componentPath 组件路径
	 * @param {string} pageFilePath 页面文件路径
	 * @returns {string} 解析后的路径
	 */
	resolveRelativePath(componentPath, pageFilePath) {
		const lastIndex = pageFilePath.lastIndexOf('/')
		const newPath = pageFilePath.slice(0, lastIndex)
		const res = path.resolve(newPath, componentPath)
		return res.replace(this.workPath, '')
	}

	/**
	 * 解析 npm 组件
	 * @param {string} componentName 组件名称
	 * @param {string} pageFilePath 页面文件路径
	 * @returns {string|null} 解析后的组件路径，如果找不到返回 null
	 */
	resolveNpmComponent(componentName, pageFilePath) {
		const searchPaths = this.generateSearchPaths(pageFilePath)
		
		for (const searchPath of searchPaths) {
			const componentPath = this.findComponentInMiniprogramNpm(componentName, searchPath)
			if (componentPath) {
				return componentPath
			}
		}

		return null
	}

	/**
	 * 生成 miniprogram_npm 搜索路径
	 * 按照微信小程序的寻址顺序生成搜索路径
	 * @param {string} pageFilePath 页面文件路径
	 * @returns {string[]} 搜索路径数组
	 */
	generateSearchPaths(pageFilePath) {
		const relativePath = pageFilePath.replace(this.workPath, '').replace(/^\//, '')
		const pathParts = relativePath.split('/').slice(0, -1) // 去掉文件名

		const searchPaths = []

		// 从当前目录开始，逐级向上查找 miniprogram_npm
		for (let i = pathParts.length; i >= 0; i--) {
			const currentPath = pathParts.slice(0, i).join('/')
			const miniprogramNpmPath = currentPath 
				? `${currentPath}/miniprogram_npm`
				: 'miniprogram_npm'
			
			searchPaths.push(miniprogramNpmPath)
		}

		return searchPaths
	}

	/**
	 * 在指定的 miniprogram_npm 目录中查找组件
	 * @param {string} componentName 组件名称
	 * @param {string} miniprogramNpmPath miniprogram_npm 路径
	 * @returns {string|null} 组件路径，如果找不到返回 null
	 */
	findComponentInMiniprogramNpm(componentName, miniprogramNpmPath) {
		const fullMiniprogramNpmPath = path.join(this.workPath, miniprogramNpmPath)
		
		if (!fs.existsSync(fullMiniprogramNpmPath)) {
			return null
		}

		// 缓存检查
		const cacheKey = `${miniprogramNpmPath}/${componentName}`
		if (this.miniprogramNpmCache.has(cacheKey)) {
			return this.miniprogramNpmCache.get(cacheKey)
		}

		// 按照微信小程序的寻址顺序查找
		const candidatePaths = [
			componentName,
			`${componentName}/index`
		]

		for (const candidatePath of candidatePaths) {
			const componentDir = path.join(fullMiniprogramNpmPath, candidatePath)
			
			// 检查是否存在组件文件
			if (this.isValidComponent(componentDir)) {
				const resolvedPath = `/${miniprogramNpmPath}/${candidatePath}`.replace(/\/+/g, '/')
				this.miniprogramNpmCache.set(cacheKey, resolvedPath)
				return resolvedPath
			}
		}

		this.miniprogramNpmCache.set(cacheKey, null)
		return null
	}

	/**
	 * 检查是否为有效的组件
	 * @param {string} componentPath 组件路径
	 * @returns {boolean} 是否为有效组件
	 */
	isValidComponent(componentPath) {
		// 检查是否存在必要的组件文件
		const requiredFiles = ['.json', '.js']
		const hasRequiredFiles = requiredFiles.some(ext => {
			return fs.existsSync(`${componentPath}${ext}`)
		})

		if (!hasRequiredFiles) {
			// 如果直接路径下没有文件，检查是否有 index 文件
			const indexFiles = requiredFiles.some(ext => {
				return fs.existsSync(path.join(componentPath, `index${ext}`))
			})
			
			if (!indexFiles) {
				return false
			}

			// 检查 index.json 文件是否标记为组件
			const indexJsonFile = path.join(componentPath, 'index.json')
			if (fs.existsSync(indexJsonFile)) {
				try {
					const config = JSON.parse(fs.readFileSync(indexJsonFile, 'utf-8'))
					return config.component === true
				} catch (e) {
					return false
				}
			}
			return true
		}

		// 检查 json 文件是否标记为组件
		const jsonFile = `${componentPath}.json`
		if (fs.existsSync(jsonFile)) {
			try {
				const config = JSON.parse(fs.readFileSync(jsonFile, 'utf-8'))
				return config.component === true
			} catch (e) {
				return false
			}
		}

		return true
	}

	/**
	 * 获取 npm 包信息
	 * @param {string} packageName 包名
	 * @param {string} searchPath 搜索路径
	 * @returns {object|null} 包信息，如果找不到返回 null
	 */
	getPackageInfo(packageName, searchPath) {
		const cacheKey = `${searchPath}/${packageName}`
		if (this.packageCache.has(cacheKey)) {
			return this.packageCache.get(cacheKey)
		}

		const packageJsonPath = path.join(this.workPath, searchPath, packageName, 'package.json')
		
		if (!fs.existsSync(packageJsonPath)) {
			this.packageCache.set(cacheKey, null)
			return null
		}

		try {
			const packageInfo = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'))
			this.packageCache.set(cacheKey, packageInfo)
			return packageInfo
		} catch (e) {
			this.packageCache.set(cacheKey, null)
			return null
		}
	}

	/**
	 * 清除缓存
	 */
	clearCache() {
		this.miniprogramNpmCache.clear()
		this.packageCache.clear()
	}
}

export { NpmResolver } 