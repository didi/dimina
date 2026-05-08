import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import build from '../index.js'

const CACHE_FILE = path.resolve('./packages/container/public/compile-cache.json')
const COMPILER_SRC_DIR = path.resolve('./packages/compiler/src')

function loadCache() {
	if (fs.existsSync(CACHE_FILE)) {
		try {
			return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'))
		}
		catch {
			return { apps: {}, compilerLastModified: 0 }
		}
	}
	return { apps: {}, compilerLastModified: 0 }
}

function saveCache(cache) {
	fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2))
}

function isModified(dirPath, lastCompileTime) {
	const files = fs.readdirSync(dirPath)
	for (const file of files) {
		const filePath = path.join(dirPath, file)
		const stats = fs.statSync(filePath)
		if (stats.isDirectory()) {
			if (isModified(filePath, lastCompileTime)) {
				return true
			}
		}
		else if (stats.mtime.getTime() > lastCompileTime) {
			return true
		}
	}
	return false
}

function isCompilerModified(lastCompileTime) {
	return isModified(COMPILER_SRC_DIR, lastCompileTime)
}

function readAppId(workPath) {
	const projectConfigPath = path.join(workPath, 'project.config.json')
	if (!fs.existsSync(projectConfigPath)) {
		return null
	}

	try {
		const projectConfig = JSON.parse(fs.readFileSync(projectConfigPath, 'utf8'))
		return projectConfig.appid || null
	}
	catch (error) {
		console.warn(`读取 ${projectConfigPath} 失败:`, error.message)
		return null
	}
}

function assertUniqueAppIds(exampleRoot, directories) {
	const appIdMap = new Map()

	for (const directory of directories) {
		const workPath = path.join(exampleRoot, directory)
		const appId = readAppId(workPath)
		if (!appId) {
			continue
		}

		const appNames = appIdMap.get(appId) || []
		appNames.push(directory)
		appIdMap.set(appId, appNames)
	}

	const duplicates = [...appIdMap.entries()].filter(([, appNames]) => appNames.length > 1)
	if (duplicates.length === 0) {
		return
	}

	const detail = duplicates
		.map(([appId, appNames]) => `${appId}: ${appNames.join(', ')}`)
		.join('\n')

	throw new Error(`检测到重复的 appid，批量编译会覆盖产物:\n${detail}`)
}

async function cleanUpOldApps(targetPath, appList) {
	try {
		// 清理目标目录
		const targetDirs = fs.readdirSync(targetPath, { withFileTypes: true })
			.filter(dirent => dirent.isDirectory())
			.map(dirent => dirent.name)

		// 从appList中提取所有appId
		const validAppIds = appList.map(app => app.appId)

		for (const dir of targetDirs) {
			// 跳过特殊目录和文件
			if (['images', '.gitignore', 'favicon.ico', 'appList.json'].includes(dir)) {
				continue
			}

			// 如果目录名不在有效的appId列表中，则删除
			if (!validAppIds.includes(dir)) {
				const dirPath = path.join(targetPath, dir)
				try {
					fs.rmSync(dirPath, { recursive: true, force: true })
					console.log(`已清理小程序产物目录: ${dirPath}`)
				}
				catch (error) {
					console.error(`清理目录失败: ${dirPath}`, error)
				}
			}
		}
	}
	catch (error) {
		console.error('清理旧应用目录时出错:', error)
	}
}

async function buildMiniApp() {
	const currentDirectory = `${process.cwd()}/example`
	const cache = loadCache()

	// 检查编译器是否被修改
	const compilerModified = isCompilerModified(cache.compilerLastModified)

	fs.readdir(currentDirectory, async (err, files) => {
		if (err) {
			console.error('无法读取目录:', err)
			return
		}

		const directories = files.filter(file => {
			const filePath = path.join(currentDirectory, file);
			return fs.existsSync(filePath) && fs.statSync(filePath).isDirectory();
		})

		assertUniqueAppIds(currentDirectory, directories)

		const appList = []
		for (const fileName of directories) {
			const workPath = path.resolve(`./example/${fileName}`)
			const targetPath = path.resolve(workPath, '../../packages/container/public')

			const lastCompileTime = cache.apps[fileName]?.lastCompileTime || 0

			// 检查是否需要重新编译
			if (compilerModified || isModified(workPath, lastCompileTime)) {
				const appInfo = await build(targetPath, workPath)
				if (appInfo) {
					appList.push(appInfo)
					// 更新这个应用的最后编译时间
					cache.apps[fileName] = {
						lastCompileTime: Date.now(),
						appInfo,
					}
				}
			}
			else {
				// 如果没有修改，使用缓存中的appInfo
				if (cache.apps[fileName]?.appInfo) {
					appList.push(cache.apps[fileName].appInfo)
				}
			}
		}

		// 按修改时间降序
		appList.sort((a, b) => {
			const timeA = getLastCompileTime(cache, a.appId)
			const timeB = getLastCompileTime(cache, b.appId)
			return timeB - timeA
		})

		const targetPath = path.resolve('./packages/container/public')
		const appListString = JSON.stringify(appList, null, 2)
		fs.writeFileSync(path.join(targetPath, 'appList.json'), appListString)

		// 清理不存在的应用目录
		await cleanUpOldApps(targetPath, appList)

		// 清理缓存中不存在的应用配置
		const cacheFileNames = Object.keys(cache.apps)
		for (const fileName of cacheFileNames) {
			if (!directories.includes(fileName)) {
				delete cache.apps[fileName]
			}
		}

		// 更新编译器的最后修改时间
		cache.compilerLastModified = Date.now()

		// 保存更新后的缓存
		saveCache(cache)
	})
}

function getLastCompileTime(data, appId) {
	for (const key in data.apps) {
		if (data.apps[key].appInfo.appId === appId) {
			return data.apps[key].lastCompileTime
		}
	}
	return 0 // 如果找不到对应的 appId
}

buildMiniApp()
