export const SYSTEM_PROMPT = `你是 Dimina 小程序开发者。只返回 JSON：{"name":"应用名称","files":{"app.json":"文件内容","app.js":"文件内容","pages/index.js":"文件内容","pages/index.wxml":"文件内容","pages/index.wxss":"文件内容"}}。
files 必须包含完整工程，修改时保留已有功能和存储 key。使用标准小程序 JavaScript、WXML、WXSS、JSON，App/Page/Component、setData 和 wx API；事件从 event.detail/event.currentTarget.dataset 取值。
只支持主包，最多 12 个页面；不要 TypeScript、npm、Less、Sass、小游戏、web-view、外部资源、网络请求或宿主扩展。数据通过异步 wx.setStorage/getStorage（success/fail 回调）持久化；Web 不支持同步存储 API，禁止使用 wx.*StorageSync。app.json 声明 pages 和 window。不要输出编译产物。` 

const forbidden = new Set(['__proto__', 'constructor', 'prototype'])
export function validateFiles(files) {
	if (!files || Array.isArray(files) || typeof files !== 'object') throw new Error('模型必须返回 files 文件对象')
	const entries = Object.entries(files)
	if (!entries.length || entries.length > 80) throw new Error('工程文件数量必须在 1 到 80 之间')
	let size = 0
	for (const [path, content] of entries) {
		if (!/^[\w/-]+\.(js|json|wxml|wxss)$/.test(path) || path.startsWith('/') || path.split('/').some(part => part === '..' || forbidden.has(part)) || path.includes('//') || path.startsWith('miniprogram_npm/')) throw new Error(`不支持的文件路径：${path}`)
		if (typeof content !== 'string') throw new Error(`${path} 内容必须是字符串`)
		size += new TextEncoder().encode(content).length
		if (size > 1024 * 1024) throw new Error('工程源码不能超过 1 MiB')
		if (path.endsWith('.json')) { try { JSON.parse(content) } catch { throw new Error(`${path} 不是有效 JSON`) } }
	}
	if (!files['app.json'] || !files['app.js']) throw new Error('缺少 app.json 或 app.js')
	const app = JSON.parse(files['app.json'])
	if (!Array.isArray(app.pages) || !app.pages.length || app.pages.length > 12 || app.subPackages || app.subpackages) throw new Error('首版支持 1 到 12 个主包页面')
	for (const page of app.pages) {
		if (typeof page !== 'string' || !files[`${page}.wxml`] || !files[`${page}.js`]) throw new Error(`页面 ${page} 缺少 WXML 或 JavaScript`)
	}
	return files
}

export function parseProject(value) {
	if (typeof value === 'string') {
		if (value.length > 2 * 1024 * 1024) throw new Error('模型输出超过大小限制')
		const content = value.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
		try { value = JSON.parse(content) } catch { throw new Error('模型输出不是有效的工程 JSON') }
	}
	if (!value || typeof value !== 'object') throw new Error('模型输出不是有效的工程对象')
	return { name: typeof value.name === 'string' ? value.name.slice(0, 60) : '我的小程序', files: validateFiles(value.files) }
}
