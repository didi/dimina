import fs from 'node:fs'
import {
	getAppConfigInfo,
	getAppId,
	getAppName,
	getPageConfigInfo,
	getTargetPath,
	getWorkPath,
} from '../env.js'
import { collectAssets } from '../common/utils.js'

/**
 * 处理 tabBar.list 中的 iconPath / selectedIconPath。
 * 视为相对小程序根目录的资源，复用 collectAssets 拷贝到 main/static/，
 * 并把 list 中的路径改写成产物 URL，避免容器侧再做特殊解析。
 *
 * 注意：会在原 app 配置上原地修改，不影响后续输出（compileConfig 是
 * 整个流水线最后才走到的环节，不会被再次读取）。
 */
function processTabBarIcons(app) {
	const list = app?.tabBar?.list
	if (!Array.isArray(list) || list.length === 0) {
		return
	}
	const workPath = getWorkPath()
	const targetPath = getTargetPath()
	const appId = getAppId()

	for (const item of list) {
		// 第二参数 pagePath 留空 → collectAssets 内部 relativePath = ''，
		// 等价于把 src 当成相对小程序根目录解析，与 app.json 同级
		if (item.iconPath) {
			item.iconPath = collectAssets(workPath, '', item.iconPath, targetPath, appId)
		}
		if (item.selectedIconPath) {
			item.selectedIconPath = collectAssets(workPath, '', item.selectedIconPath, targetPath, appId)
		}
	}
}

/**
 *
 * 编译项目配置文件 app-config.json
 */
function compileConfig() {
	const app = getAppConfigInfo()

	// 把 tabBar 图标复制到产物目录并改写 iconPath
	processTabBarIcons(app)

	const compileResInfo = {
		app,
		modules: getPageConfigInfo(),
		projectName: getAppName(),
	}

	const json = JSON.stringify(compileResInfo, null, 4)
	const mainDir = `${getTargetPath()}/main`
	if (!fs.existsSync(mainDir)) {
		fs.mkdirSync(mainDir, { recursive: true })
	}
	fs.writeFileSync(`${mainDir}/app-config.json`, json)
}

export default compileConfig
