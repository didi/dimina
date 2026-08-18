#!/usr/bin/env node

const os = require('node:os')
const path = require('node:path')
const process = require('node:process')
const fsExtra = require('fs-extra')

// Define paths relative to the script location
const rootDir = path.resolve(__dirname, '..')
const sourceDir = path.join(rootDir, 'packages/container/dist/assets/')
const tempDir = path.join(os.tmpdir(), `dimina-jssdk-${Date.now()}`)
const jsSdkDir = tempDir
const mainDir = path.join(jsSdkDir, 'main/')
const targetDir = path.join(mainDir, 'assets/')
const sharedJssdkDir = path.resolve(__dirname, '../../shared/jssdk/')

async function zipDirectory(sourceDir, outputFile) {
	const { ZipArchive } = await import('archiver')
	const output = fsExtra.createWriteStream(outputFile)
	const archive = new ZipArchive({
		zlib: { level: 9 },
	})

	return new Promise((resolve, reject) => {
		output.on('close', () => {
			console.log('压缩成功')
			resolve()
		})

		archive.on('error', (err) => {
			reject(err)
		})

		archive.pipe(output)
		archive.directory(sourceDir, 'main')
		archive.finalize()
	})
}

async function updateConfigVersion() {
	const configPath = path.join(sharedJssdkDir, 'config.json')
	try {
		// 确保config.json存在
		if (!await fsExtra.pathExists(configPath)) {
			// 创建默认配置
			const defaultConfig = {
				versionCode: 1,
				versionName: '1.0.0',
			}
			await fsExtra.writeJson(configPath, defaultConfig, { spaces: 2 })
			console.log('创建了新的配置文件')
			return defaultConfig
		}

		// 读取配置文件
		const config = await fsExtra.readJson(configPath)

		// 更新版本号
		config.versionCode += 1
		const versionParts = config.versionName.split('.')
		versionParts[2] = (Number.parseInt(versionParts[2]) + 1).toString()
		config.versionName = versionParts.join('.')

		// 写入更新后的配置
		await fsExtra.writeJson(configPath, config, { spaces: 2 })
		console.log(`配置版本已更新至 ${config.versionName} (${config.versionCode})`)
		return config
	}
	catch (err) {
		console.error('更新配置版本失败：', err)
		throw err
	}
}

async function generateSdk() {
	try {
		// 确保jsSdkDir目录存在
		await fsExtra.ensureDir(jsSdkDir)

		// 检查sharedJssdkDir是否存在，但不创建
		const sharedJssdkExists = await fsExtra.pathExists(sharedJssdkDir)

		// 如果存在 main 目录，先删除
		await fsExtra.remove(mainDir)

		// 确保dist目录存在
		const distDir = path.join(rootDir, 'packages/container/dist')
		if (!await fsExtra.pathExists(distDir)) {
			console.error('错误: dist目录不存在，请先运行构建命令')
			process.exit(1)
		}

		// 复制 assets 目录
		await fsExtra.copy(sourceDir, targetDir, {
			filter: src => !src.includes('index.'),
		})

		// 复制 pageFrame.html
		const pageFramePath = path.join(rootDir, 'packages/container/dist/pageFrame.html')
		const targetPageFramePath = path.join(mainDir, 'pageFrame.html')
		await fsExtra.copyFile(pageFramePath, targetPageFramePath)

		// 压缩目录
		const zipPath = path.join(jsSdkDir, 'main.zip')
		await zipDirectory(mainDir, zipPath)

		// 更新配置版本，仅当shared目录存在时
		let updatedConfig
		if (sharedJssdkExists) {
			updatedConfig = await updateConfigVersion()

			// 复制 main.zip 到 shared/jssdk 目录
			await fsExtra.copy(zipPath, path.join(sharedJssdkDir, 'main.zip'))
			console.log(`已将 main.zip 复制到 ${sharedJssdkDir}`)

			// 清理临时目录
			try {
				await fsExtra.remove(tempDir)
				console.log('临时目录已清理')
			}
			catch (cleanupErr) {
				console.warn('清理临时目录失败：', cleanupErr)
			}
		}
		else {
			console.log(`注意: ${sharedJssdkDir} 目录不存在，跳过复制操作`)
			console.log(`SDK 当前存放地址为： ${tempDir}`)
			// 使用默认版本信息
			updatedConfig = { versionName: '1.0.0', versionCode: 1 }
		}
		console.log(`SDK 生成完成，版本 ${updatedConfig.versionName}`)
	}
	catch (err) {
		console.error('生成 SDK 过程中发生错误：', err)

		// 即使出错也尝试清理临时目录
		try {
			await fsExtra.remove(tempDir)
			console.log('临时目录已清理')
		}
		catch (cleanupErr) {
			console.warn('清理临时目录失败：', cleanupErr)
		}

		process.exit(1)
	}
}

generateSdk()
