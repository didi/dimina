import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * npm 构建工具
 * 用于处理小程序 npm 包的构建和管理
 */
class NpmBuilder {
	constructor(workPath, targetPath) {
		this.workPath = workPath
		this.targetPath = targetPath
		this.builtPackages = new Set()
		this.packageDependencies = new Map()
	}

	/**
	 * 构建 npm 包
	 * 扫描 miniprogram_npm 目录并构建相关包
	 */
	async buildNpmPackages() {
		const miniprogramNpmPaths = this.findMiniprogramNpmDirs()
		
		for (const npmPath of miniprogramNpmPaths) {
			await this.buildNpmDir(npmPath)
		}

		console.log(`[npm-builder] 已构建 ${this.builtPackages.size} 个 npm 包`)
	}

	/**
	 * 查找所有 miniprogram_npm 目录
	 * @returns {string[]} miniprogram_npm 目录路径数组
	 */
	findMiniprogramNpmDirs() {
		const npmDirs = []
		
		const scanDir = (dir, relativePath = '') => {
			if (!fs.existsSync(dir)) {
				return
			}

			const items = fs.readdirSync(dir, { withFileTypes: true })
			
			for (const item of items) {
				if (item.isDirectory()) {
					const itemPath = path.join(dir, item.name)
					const itemRelativePath = relativePath ? `${relativePath}/${item.name}` : item.name

					if (item.name === 'miniprogram_npm') {
						npmDirs.push(itemRelativePath)
					} else {
						// 递归扫描子目录
						scanDir(itemPath, itemRelativePath)
					}
				}
			}
		}

		scanDir(this.workPath)
		return npmDirs
	}

	/**
	 * 构建指定的 miniprogram_npm 目录
	 * @param {string} npmDirPath miniprogram_npm 目录路径
	 */
	async buildNpmDir(npmDirPath) {
		const fullNpmPath = path.join(this.workPath, npmDirPath)
		
		if (!fs.existsSync(fullNpmPath)) {
			return
		}

		const packages = fs.readdirSync(fullNpmPath, { withFileTypes: true })
			.filter(item => item.isDirectory())
			.map(item => item.name)

		for (const packageName of packages) {
			await this.buildPackage(packageName, npmDirPath)
		}
	}

	/**
	 * 构建单个 npm 包
	 * @param {string} packageName 包名
	 * @param {string} npmDirPath miniprogram_npm 目录路径
	 */
	async buildPackage(packageName, npmDirPath) {
		const packageKey = `${npmDirPath}/${packageName}`
		
		if (this.builtPackages.has(packageKey)) {
			return
		}

		const packagePath = path.join(this.workPath, npmDirPath, packageName)
		const targetPackagePath = path.join(this.targetPath, npmDirPath, packageName)

		// 确保目标目录存在
		if (!fs.existsSync(path.dirname(targetPackagePath))) {
			fs.mkdirSync(path.dirname(targetPackagePath), { recursive: true })
		}

		// 复制包文件
		await this.copyPackageFiles(packagePath, targetPackagePath)

		// 处理包依赖
		await this.processDependencies(packageName, packagePath, npmDirPath)

		this.builtPackages.add(packageKey)
		console.log(`[npm-builder] 已构建包: ${packageKey}`)
	}

	/**
	 * 复制包文件
	 * @param {string} sourcePath 源路径
	 * @param {string} targetPath 目标路径
	 */
	async copyPackageFiles(sourcePath, targetPath) {
		if (!fs.existsSync(sourcePath)) {
			return
		}

		// 确保目标目录存在
		if (!fs.existsSync(targetPath)) {
			fs.mkdirSync(targetPath, { recursive: true })
		}

		const items = fs.readdirSync(sourcePath, { withFileTypes: true })

		for (const item of items) {
			const sourceItemPath = path.join(sourcePath, item.name)
			const targetItemPath = path.join(targetPath, item.name)

			if (item.isDirectory()) {
				await this.copyPackageFiles(sourceItemPath, targetItemPath)
			} else {
				// 只复制小程序相关文件
				if (this.isMiniprogramFile(item.name)) {
					fs.copyFileSync(sourceItemPath, targetItemPath)
				}
			}
		}
	}

	/**
	 * 检查是否为小程序相关文件
	 * @param {string} filename 文件名
	 * @returns {boolean} 是否为小程序文件
	 */
	isMiniprogramFile(filename) {
		const miniprogramExts = ['.js', '.json', '.wxml', '.wxss', '.wxs', '.ts', '.less', '.scss', '.styl']
		const ext = path.extname(filename).toLowerCase()
		
		return miniprogramExts.includes(ext) || 
			   filename === 'package.json' ||
			   filename === 'README.md' ||
			   filename.startsWith('.')
	}

	/**
	 * 处理包依赖
	 * @param {string} packageName 包名
	 * @param {string} packagePath 包路径
	 * @param {string} npmDirPath npm 目录路径
	 */
	async processDependencies(packageName, packagePath, npmDirPath) {
		const packageJsonPath = path.join(packagePath, 'package.json')
		
		if (!fs.existsSync(packageJsonPath)) {
			return
		}

		try {
			const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'))
			const dependencies = {
				...packageJson.dependencies,
				...packageJson.peerDependencies
			}

			if (dependencies && Object.keys(dependencies).length > 0) {
				this.packageDependencies.set(packageName, dependencies)
				
				// 递归构建依赖包
				for (const depName of Object.keys(dependencies)) {
					await this.buildPackage(depName, npmDirPath)
				}
			}
		} catch (e) {
			console.warn(`[npm-builder] 解析 package.json 失败: ${packageJsonPath}`, e.message)
		}
	}

	/**
	 * 验证 npm 包的完整性
	 * @param {string} packageName 包名
	 * @param {string} packagePath 包路径
	 * @returns {boolean} 是否有效
	 */
	validatePackage(packageName, packagePath) {
		// 检查必要文件是否存在
		const requiredFiles = ['package.json']
		
		for (const file of requiredFiles) {
			if (!fs.existsSync(path.join(packagePath, file))) {
				console.warn(`[npm-builder] 包 ${packageName} 缺少必要文件: ${file}`)
				return false
			}
		}

		// 检查 package.json 格式
		try {
			const packageJsonPath = path.join(packagePath, 'package.json')
			const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'))
			
			if (!packageJson.name || !packageJson.version) {
				console.warn(`[npm-builder] 包 ${packageName} 的 package.json 格式不正确`)
				return false
			}
		} catch (e) {
			console.warn(`[npm-builder] 包 ${packageName} 的 package.json 解析失败:`, e.message)
			return false
		}

		return true
	}

	/**
	 * 获取已构建的包列表
	 * @returns {string[]} 已构建的包列表
	 */
	getBuiltPackages() {
		return Array.from(this.builtPackages)
	}

	/**
	 * 获取包依赖关系
	 * @returns {Map} 包依赖关系映射
	 */
	getPackageDependencies() {
		return this.packageDependencies
	}

	/**
	 * 清理构建缓存
	 */
	clearCache() {
		this.builtPackages.clear()
		this.packageDependencies.clear()
	}
}

export { NpmBuilder } 