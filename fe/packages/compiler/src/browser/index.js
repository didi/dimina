import { resetFiles, outputFiles } from './fs.js'
import { initializeParser } from './parser.js'
import { initializeTransform } from './transform.js'
import { storeInfo, getPages } from '../env.js'
import { resetAssetCache } from '../common/utils.js'
import { compileML } from '../core/view-compiler.js'
import { compileSS } from '../core/style-compiler.js'
import { compileJS } from '../core/logic-compiler.js'
import compileConfig from '../core/config-compiler.js'
import fs from './fs.js'

let initialization
let consumed = false
/** Compile a virtual source tree. Run in a fresh Worker for each job. */
export async function compile(files, { appId = 'generated-app', name = '我的小程序' } = {}) {
	if (consumed) throw new Error('The browser compiler accepts one job per Worker; create a fresh Worker for the next compilation')
	consumed = true
	const app = JSON.parse(files['app.json'])
	if (!Array.isArray(app.pages) || !app.pages.length || app.subPackages || app.subpackages) throw new Error('The browser compiler requires a main-package mini program')
	initialization ||= Promise.all([initializeParser(), initializeTransform()])
	await initialization
	resetFiles({ ...files, 'project.config.json': JSON.stringify({ appid: appId, projectname: name, compileType: 'miniprogram' }) })
	resetAssetCache()
	storeInfo('/project')
	const pages = getPages()
	await compileML(pages.mainPages, null, { completedTasks: 0 })
	await compileSS(pages.mainPages, null, { completedTasks: 0 })
	if (!fs.existsSync('/output/main/app.css')) fs.writeFileSync('/output/main/app.css', '')
	const logic = await compileJS(pages.mainPages, null, null, { completedTasks: 0 })
	fs.writeFileSync('/output/main/logic.js', logic.map(module => `modDefine(${JSON.stringify(module.path)}, function(require, module, exports) {\n${module.code}\n});`).join('\n'))
	compileConfig()
	return outputFiles()
}
