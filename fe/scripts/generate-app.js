#!/usr/bin/env node

const { execSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const process = require('node:process')

// ===================== 新增：自动检查并安装依赖 =====================
let fse = null
let archiver = null

/**
 * 检查并自动安装缺失的依赖
 */
function checkAndInstallDeps() {
  try {
    // 尝试加载依赖
    fse = require('fs-extra')
    archiver = require('archiver')
    console.log('✅ 依赖 fs-extra 和 archiver 已存在，无需重新安装')
  } catch (err) {
    if (err.code === 'MODULE_NOT_FOUND') {
      console.log('⚠️  检测到依赖 fs-extra 或 archiver 缺失，正在自动安装...')
      try {
        // 执行 pnpm 安装依赖（与你的项目包管理器保持一致）
        execSync('pnpm add fs-extra archiver -D', {
          stdio: 'inherit', // 输出安装日志到控制台
          cwd: path.resolve(__dirname, '../') // 确保在项目根目录执行安装
        })
        console.log('✅ 依赖安装完成！')

        // 清除模块缓存，重新加载依赖
        delete require.cache[require.resolve('fs-extra')]
        delete require.cache[require.resolve('archiver')]
        fse = require('fs-extra')
        archiver = require('archiver')
      } catch (installErr) {
        console.error('❌ 依赖自动安装失败！')
        console.error('请手动执行命令安装：pnpm add fs-extra archiver -D')
        process.exit(1)
      }
    } else {
      console.error('❌ 加载依赖时出现未知错误：', err)
      process.exit(1)
    }
  }
}

// 优先执行依赖检查与安装
checkAndInstallDeps()
// ================================================================

// 定义路径
const publicPath = path.resolve(__dirname, '../packages/container/public')
const sharedJsappPath = path.resolve(__dirname, '../../shared/jsapp')

// 检查shared/jsapp目录是否存在
if (!fs.existsSync(sharedJsappPath)) {
	console.error(`❌ 错误：目录 ${sharedJsappPath} 不存在。`)
	console.error('请先创建该目录后再运行此命令。')
	process.exit(1) // 终止脚本并返回错误码
}

// 获取public下所有符合规则的应用目录
const appDirs = fs.readdirSync(publicPath)
	.filter((item) => {
		const itemPath = path.join(publicPath, item)
		return fs.statSync(itemPath).isDirectory() && (item.startsWith('wx') || item.startsWith('dd'))
	})

console.log('📂 找到的应用目录：', appDirs)

// 封装压缩文件函数（使用archiver，跨平台）
const zipDirectory = async (sourceDir, outputZipPath) => {
  return new Promise((resolve, reject) => {
    // 创建写入流
    const output = fs.createWriteStream(outputZipPath)
    const archive = archiver('zip', { zlib: { level: 9 } }) // 最高压缩级别

    // 监听事件
    output.on('close', () => resolve())
    archive.on('error', (err) => reject(err))

    // 开始打包
    archive.pipe(output)
    archive.directory(sourceDir, false) // false：不包含源目录本身，只包含目录内文件
    archive.finalize()
  })
}

// 处理每个应用目录
appDirs.forEach(async (appId) => {
	const appPublicPath = path.join(publicPath, appId)
	const appSharedPath = path.join(sharedJsappPath, appId)

	// 若shared/jsapp中无此应用目录则创建
	if (!fs.existsSync(appSharedPath)) {
		fs.mkdirSync(appSharedPath, { recursive: true })
	}

	// 检查应用主目录下的app-config.json是否存在
	const appConfigPath = path.join(appPublicPath, 'main', 'app-config.json')
	let appName = `应用 ${appId}`
	let appPath = 'example/index'

	// 若存在则从app-config.json提取名称和路径
	if (fs.existsSync(appConfigPath)) {
		try {
			const appConfig = JSON.parse(fs.readFileSync(appConfigPath, 'utf8'))
			if (appConfig.app && appConfig.projectName) {
				appName = appConfig.projectName
			}
			// 优先获取入口页面路径，无则取pages数组第一个页面
			if (appConfig.app && appConfig.app.entryPagePath) {
				appPath = appConfig.app.entryPagePath
			}
			else if (appConfig.app && appConfig.app.pages && appConfig.app.pages.length > 0) {
				appPath = appConfig.app.pages[0]
			}
			console.log(`✅ 从${appId}的app-config.json提取信息：名称=${appName}，路径=${appPath}`)
		}
		catch (error) {
			console.error(`❌ 读取或解析${appId}的app-config.json失败：`, error)
		}
	}

	// 检查shared/jsapp下的config.json是否存在
	const configPath = path.join(appSharedPath, 'config.json')
	let config = {
		appId,
		name: appName,
		path: appPath,
		versionCode: 1,
		versionName: '1.0.0',
	}

	// 若配置存在则读取并递增版本号
	if (fs.existsSync(configPath)) {
		try {
			config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
			config.versionCode += 1

			// 递增版本名称的最后一位（如：1.0.0 -> 1.0.1）
			const versionParts = config.versionName.split('.')
			versionParts[versionParts.length - 1] = (Number.parseInt(versionParts[versionParts.length - 1]) + 1).toString()
			config.versionName = versionParts.join('.')

			console.log(`🔢 为${appId}递增版本号：${config.versionName}（版本编码：${config.versionCode}）`)
		}
		catch (error) {
			console.error(`❌ 读取或解析${appId}的配置文件失败：`, error)
		}
	}
	else {
		console.log(`📝 为${appId}创建新的配置文件`)
	}

	// 写入更新后的配置
	fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8')

	// 从应用目录创建zip压缩包
	try {
		// 为应用文件创建临时目录
		const tempDir = path.join(__dirname, `../temp-${appId}`)
		if (fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true })
		}
		fs.mkdirSync(tempDir, { recursive: true })

		// 将应用目录下所有文件复制到临时目录
		fse.copySync(appPublicPath, tempDir, { overwrite: true })

		// 创建zip文件
		const zipPath = path.join(appSharedPath, `${appId}.zip`)
		await zipDirectory(tempDir, zipPath)

		// 清理临时目录
		fs.rmSync(tempDir, { recursive: true, force: true })

		console.log(`📦 成功创建压缩包：${zipPath}`)
	}
	catch (error) {
		console.error(`❌ 为${appId}创建压缩包失败：`, error)
	}
})

console.log('\n🎉 应用包生成流程执行完成！')