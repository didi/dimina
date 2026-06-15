import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
	getStyleExts,
	getTemplateExts,
	getViewScriptExts,
	getViewScriptTags,
	resetStoreInfo,
	storeInfo,
} from '../src/env.js'

/**
 * 「可配置小程序自定义文件类型（custom file types）」特性的契约测试。
 *
 * 实现尚未存在 —— 这些测试当前应当失败（getter 未导出 / storeInfo 不接受 options）。
 * 每个测试都对应一个会真实发生的 bug，而不是同义反复。
 *
 * 注意：env 是模块级单例，测试之间通过 storeInfo()/resetStoreInfo() 互相影响，
 * 所以每个 case 都显式重新调用 storeInfo() 建立自己的输入，不依赖上一个 case 的状态。
 */

let tempDir

function writeProjectFile(filePath, content) {
	const fullPath = path.join(tempDir, filePath)
	fs.mkdirSync(path.dirname(fullPath), { recursive: true })
	fs.writeFileSync(fullPath, content)
}

/**
 * 写出一个最小可被 storeInfo() 解析的小程序工程（app.json + 一个页面）。
 * storeInfo 内部会读取 app.json / project.config.json，缺了会抛错。
 */
function prepareMinimalProject() {
	writeProjectFile('app.json', JSON.stringify({ pages: ['pages/home/index'] }))
	writeProjectFile('project.config.json', JSON.stringify({ appid: 'custom-test' }))
	writeProjectFile('pages/home/index.json', JSON.stringify({}))
	writeProjectFile('pages/home/index.wxml', '<view>home</view>')
	writeProjectFile('pages/home/index.wxss', '')
	writeProjectFile('pages/home/index.js', 'Page({})')
}

describe('custom file types — getters 默认值', () => {
	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-default-'))
		prepareMinimalProject()
		// 不注入任何 fileTypes，期望落在内置默认值
		storeInfo(tempDir)
	})

	afterEach(() => {
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true })
		}
	})

	// bug：默认模板扩展名漏掉 dd 系会导致 .ddml 工程编译不出 view.js
	it('getTemplateExts 默认含内置 .wxml 与 .ddml', () => {
		expect(getTemplateExts()).toEqual(['.wxml', '.ddml'])
	})

	// bug：样式默认值漏掉预处理器会导致 .less/.scss 文件被当成未知类型跳过
	it('getStyleExts 默认含内置样式与预处理器扩展名', () => {
		expect(getStyleExts()).toEqual(['.wxss', '.ddss', '.less', '.scss', '.sass'])
	})

	// bug：viewScript 默认值多/少一项会让 .wxs 文件无法被收集
	it('getViewScriptExts 默认仅含 .wxs', () => {
		expect(getViewScriptExts()).toEqual(['.wxs'])
	})

	// bug：内联标签若误带前导点（'.wxs'）则 <wxs> 标签匹配不到
	it('getViewScriptTags 默认含 wxs 与 dds 且不带前导点', () => {
		const tags = getViewScriptTags()
		expect(tags).toEqual(['wxs', 'dds'])
		for (const tag of tags) {
			expect(tag.startsWith('.')).toBe(false)
		}
	})
})

describe('custom file types — 注入自定义文件类型', () => {
	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-inject-'))
		prepareMinimalProject()
	})

	afterEach(() => {
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true })
		}
	})

	// bug：注入的自定义模板扩展名没被追加 → .qdml 工程无法识别为模板
	it('注入 template:[qdml] 后 getTemplateExts 追加 .qdml（内置在前、自定义在后）', () => {
		storeInfo(tempDir, { fileTypes: { template: ['qdml'] } })
		expect(getTemplateExts()).toEqual(['.wxml', '.ddml', '.qdml'])
	})

	// bug：缺少自动补点会让用户传 'qdss' 时永远匹配不到 'foo.qdss'
	it('注入 style:[qdss]（无点）后 getStyleExts 追加 .qdss', () => {
		storeInfo(tempDir, { fileTypes: { style: ['qdss'] } })
		expect(getStyleExts()).toEqual(['.wxss', '.ddss', '.less', '.scss', '.sass', '.qdss'])
	})

	// bug：viewScript 扩展名注入失败 → .qds 文件不被当作 WXS 类脚本
	it('注入 viewScript:[qds] 后 getViewScriptExts 追加 .qds', () => {
		storeInfo(tempDir, { fileTypes: { viewScript: ['qds'] } })
		expect(getViewScriptExts()).toEqual(['.wxs', '.qds'])
	})

	// bug：viewScript 注入只更新了扩展名却忘了内联标签 → <qds module> 标签无法解析
	it('注入 viewScript:[qds] 后 getViewScriptTags 追加 qds（不带点）', () => {
		storeInfo(tempDir, { fileTypes: { viewScript: ['qds'] } })
		expect(getViewScriptTags()).toEqual(['wxs', 'dds', 'qds'])
	})

	// bug：用户已带前导点时如果再补点会得到 '..qdml'
	it('用户传带前导点的扩展名（.qdml）应被规范化为单个点', () => {
		storeInfo(tempDir, { fileTypes: { template: ['.qdml'] } })
		expect(getTemplateExts()).toEqual(['.wxml', '.ddml', '.qdml'])
	})

	// bug：大小写不一致会让 macOS（大小写不敏感）与 CI（敏感）行为分裂
	it('扩展名应被转为小写', () => {
		storeInfo(tempDir, { fileTypes: { template: ['.QDML'] } })
		expect(getTemplateExts()).toEqual(['.wxml', '.ddml', '.qdml'])
	})

	// bug：去重缺失 → 用户重复传或与内置撞名会产生重复项，污染查找顺序
	it('与内置同名或重复传入的扩展名应去重（不产生重复 .wxml）', () => {
		storeInfo(tempDir, { fileTypes: { template: ['wxml', '.WXML', 'qdml', 'qdml'] } })
		const exts = getTemplateExts()
		expect(exts).toEqual(['.wxml', '.ddml', '.qdml'])
		// 显式断言无重复
		expect(new Set(exts).size).toBe(exts.length)
	})

	// bug：空串若被补成 '.' 会匹配任意以点结尾的路径
	it('空串扩展名应被静默丢弃', () => {
		storeInfo(tempDir, { fileTypes: { template: ['', '   ', 'qdml'] } })
		expect(getTemplateExts()).toEqual(['.wxml', '.ddml', '.qdml'])
	})

	// bug：含路径分隔符的项若被当扩展名拼进 glob 会逃逸出目标目录
	it('含路径分隔符（/ 或 \\）的项应被静默丢弃', () => {
		storeInfo(tempDir, { fileTypes: { template: ['a/b', 'c\\d', 'qdml'] } })
		expect(getTemplateExts()).toEqual(['.wxml', '.ddml', '.qdml'])
	})

	// bug：viewScript 标签 getter 也必须执行同样的归一化（小写/去重/丢非法）
	it('viewScript 标签 getter 同样做小写与去重归一化', () => {
		storeInfo(tempDir, { fileTypes: { viewScript: ['QDS', 'qds', 'wxs'] } })
		const tags = getViewScriptTags()
		expect(tags).toEqual(['wxs', 'dds', 'qds'])
		expect(new Set(tags).size).toBe(tags.length)
	})

	// bug：标签会被拼成 Cheerio 选择器（transTagWxs 的 $(tags.join(','))），
	// 含逗号的项如 'qds,view' 会让选择器变成 wxs,dds,qds,view，把所有 <view> 选中并 remove，
	// 破坏模板。带选择器元字符的项必须被丢弃。
	it('viewScript 含选择器元字符（逗号/冒号/点）的项被丢弃', () => {
		storeInfo(tempDir, { fileTypes: { viewScript: ['qds,view', 'a:b', 'x.y', 'qds'] } })
		expect(getViewScriptTags()).toEqual(['wxs', 'dds', 'qds'])
		expect(getViewScriptExts()).toEqual(['.wxs', '.qds'])
	})

	// bug：标签名必须以字母开头（合法 XML/HTML 标签名），数字开头的项丢弃
	it('数字开头的 viewScript 标签被丢弃（非法标签名）', () => {
		storeInfo(tempDir, { fileTypes: { viewScript: ['1qds', 'qds'] } })
		expect(getViewScriptTags()).toEqual(['wxs', 'dds', 'qds'])
	})

	// bug：扩展名同样会被拼进剥除正则/查找逻辑，含元字符（内部点、*、逗号）的项必须丢弃
	it('template/style 含元字符的扩展名被丢弃', () => {
		storeInfo(tempDir, { fileTypes: { template: ['q.dml', 'qd*ml', 'a,b', 'qdml'], style: ['q:ss', 'qdss'] } })
		expect(getTemplateExts()).toEqual(['.wxml', '.ddml', '.qdml'])
		expect(getStyleExts()).toEqual(['.wxss', '.ddss', '.less', '.scss', '.sass', '.qdss'])
	})

	// bug：自定义项若占用其他角色/逻辑(.js/.ts)/配置(.json)的扩展名，会跨角色串编
	// （如 template:['js'] 把页面逻辑文件当模板解析）。保留扩展名必须被丢弃。
	it('占用保留扩展名（其他角色/逻辑/配置）的自定义项被丢弃', () => {
		storeInfo(tempDir, { fileTypes: {
			template: ['js', 'ts', 'json', 'wxss', 'qdml'],
			viewScript: ['js', 'wxml', 'qds'],
		} })
		expect(getTemplateExts()).toEqual(['.wxml', '.ddml', '.qdml'])
		expect(getViewScriptExts()).toEqual(['.wxs', '.qds'])
	})
})

describe('custom file types — storeInfo 返回值 compilerOptions', () => {
	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-store-'))
		prepareMinimalProject()
	})

	afterEach(() => {
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true })
		}
	})

	// bug：worker 还原路径靠 resetStoreInfo({...storeInfo()})，若 storeInfo 不返回
	// compilerOptions，子进程将丢失自定义文件类型配置 → 主/子进程编译结果不一致
	it('storeInfo 返回值在 pathInfo/configInfo 之外新增 compilerOptions', () => {
		const result = storeInfo(tempDir, { fileTypes: { template: ['qdml'] } })
		expect(result).toHaveProperty('pathInfo')
		expect(result).toHaveProperty('configInfo')
		expect(result).toHaveProperty('compilerOptions')
	})

	// bug：resetStoreInfo 不还原 compilerOptions → worker 端 getter 退回默认值
	it('resetStoreInfo 能还原 compilerOptions（worker 还原路径）', () => {
		const snapshot = storeInfo(tempDir, { fileTypes: { template: ['qdml'] } })

		// 模拟另一次 storeInfo 把单例覆盖回默认
		storeInfo(tempDir)
		expect(getTemplateExts()).not.toContain('.qdml')

		// 模拟 worker：用快照还原
		resetStoreInfo(snapshot)
		expect(getTemplateExts()).toContain('.qdml')
	})
})

describe('custom file types — 跨构建重置（不泄漏）', () => {
	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-reset-'))
		prepareMinimalProject()
	})

	afterEach(() => {
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true })
		}
	})

	// 关键 bug：env 单例 + build() 反复调用。若 compilerOptions 不在每次 storeInfo
	// 时按本次 options 重建，上一次注入的 .qdml 会泄漏到下一次无配置的构建。
	it('上一次注入的自定义扩展名不得泄漏到下一次无 fileTypes 的 storeInfo', () => {
		storeInfo(tempDir, { fileTypes: { template: ['qdml'] } })
		expect(getTemplateExts()).toContain('.qdml')

		storeInfo(tempDir)
		expect(getTemplateExts()).not.toContain('.qdml')
		expect(getTemplateExts()).toEqual(['.wxml', '.ddml'])
	})

	// bug：泄漏不仅发生在 template，style/viewScript 三个角色都必须各自按本次重建
	it('style 与 viewScript 同样不跨构建泄漏', () => {
		storeInfo(tempDir, { fileTypes: { style: ['qdss'], viewScript: ['qds'] } })
		expect(getStyleExts()).toContain('.qdss')
		expect(getViewScriptExts()).toContain('.qds')
		expect(getViewScriptTags()).toContain('qds')

		storeInfo(tempDir, { fileTypes: { template: ['qdml'] } })
		// 本次只注入了 template，上次的 style/viewScript 自定义扩展名应消失
		expect(getStyleExts()).not.toContain('.qdss')
		expect(getViewScriptExts()).not.toContain('.qds')
		expect(getViewScriptTags()).not.toContain('qds')
		// 而本次的 template 自定义扩展名应生效
		expect(getTemplateExts()).toContain('.qdml')
	})
})

/**
 * 行为/集成层占位。
 *
 * 这里需要一个含 .qdml + .qdss + .qds 文件以及内联 <qds module="..."> 标签的最小工程，
 * 跑完整 compileV/compileSS 并断言其产物与等价 wxml/wxss/wxs 工程一致。
 * fixture 与编译管线挂接成本较高（涉及多个 core 模块如何消费这四个 getter），
 * 先以 it.todo 锁定意图，待 env 层契约稳定后再补。
 */
describe('custom file types — 行为层（集成）', () => {
	let originalTargetPath

	beforeEach(() => {
		originalTargetPath = process.env.TARGET_PATH
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-integration-'))
	})

	afterEach(() => {
		if (originalTargetPath) {
			process.env.TARGET_PATH = originalTargetPath
		}
		else {
			delete process.env.TARGET_PATH
		}
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true })
		}
	})

	/**
	 * 写出一个最小工程骨架（不含模板/样式文件，由各 case 自己用自定义扩展名补齐）。
	 *
	 * 注意：view-compiler 有模块级 compileResCache（按 module.path 缓存），且本文件内
	 * 测试共享同一模块实例。若多个 case 复用同一页面路径，后跑的会命中前一个 case 的
	 * 编译缓存，读到串味的产物。因此每个集成 case 用各自唯一的 pagePath 隔离缓存键。
	 */
	function prepareSkeleton(pagePath) {
		writeProjectFile('app.json', JSON.stringify({ pages: [pagePath] }))
		writeProjectFile('project.config.json', JSON.stringify({ appid: 'custom-int' }))
		writeProjectFile(`${pagePath}.json`, JSON.stringify({}))
		writeProjectFile(`${pagePath}.js`, 'Page({})')
	}

	function setTargetPath() {
		const outputDir = path.join(tempDir, 'dist')
		fs.mkdirSync(outputDir, { recursive: true })
		process.env.TARGET_PATH = outputDir
		return outputDir
	}

	// bug：自定义模板扩展名注入后，view-compiler 仍只 glob .wxml → .qdml 工程编不出 view.js
	it('.qdml 被识别为模板，编译出与 .wxml 等价的 view.js', async () => {
		const pagePath = 'pages/tpl/index'
		prepareSkeleton(pagePath)
		// 页面只提供 .qdml 模板（无 .wxml），含一个可识别的组件引用作为特征串
		writeProjectFile(`${pagePath}.json`, JSON.stringify({
			usingComponents: { nav: '/components/nav' },
		}))
		writeProjectFile(`${pagePath}.qdml`, '<view><nav /></view>')
		writeProjectFile('components/nav/index.json', JSON.stringify({ component: true }))
		writeProjectFile('components/nav/index.qdml', '<view class="nav">nav</view>')

		const outputDir = setTargetPath()

		const { storeInfo: store, getPages } = await import('../src/env.js')
		store(tempDir, { fileTypes: { template: ['qdml'] } })

		const { compileML } = await import('../src/core/view-compiler.js')
		await compileML(getPages().mainPages, null, { completedTasks: 0 })

		const outputPath = path.join(outputDir, 'main/pages_tpl_index.js')
		expect(fs.existsSync(outputPath)).toBe(true)

		const output = fs.readFileSync(outputPath, 'utf-8')
		// 特征串：模板里引用的组件路径必须出现在产物中，证明 .qdml 被当模板编译了
		expect(output).toContain('/components/nav')
	})

	// 对照：同样的 .qdml 工程，若不注入 fileTypes，.qdml 不应被识别为模板
	// （产物不存在或不含该组件引用），证明上面的成功是自定义文件类型生效而非碰巧。
	it('对照：不注入 fileTypes 时同样的 .qdml 工程不产出含该内容的 view.js', async () => {
		const pagePath = 'pages/tplneg/index'
		prepareSkeleton(pagePath)
		writeProjectFile(`${pagePath}.json`, JSON.stringify({
			usingComponents: { nav: '/components/nav' },
		}))
		writeProjectFile(`${pagePath}.qdml`, '<view><nav /></view>')
		writeProjectFile('components/nav/index.json', JSON.stringify({ component: true }))
		writeProjectFile('components/nav/index.qdml', '<view class="nav">nav</view>')

		const outputDir = setTargetPath()

		const { storeInfo: store, getPages } = await import('../src/env.js')
		store(tempDir) // 不注入自定义文件类型

		const { compileML } = await import('../src/core/view-compiler.js')
		await compileML(getPages().mainPages, null, { completedTasks: 0 })

		const outputPath = path.join(outputDir, 'main/pages_tplneg_index.js')
		const exists = fs.existsSync(outputPath)
		if (exists) {
			const output = fs.readFileSync(outputPath, 'utf-8')
			// 没注入配置时不应把 .qdml 当模板编进去
			expect(output).not.toContain('class="nav"')
		}
		else {
			expect(exists).toBe(false)
		}
	})

	// bug：自定义样式扩展名注入后，style-compiler 仍只 glob .wxss → .qdss 规则丢失
	it('.qdss 被识别为样式，编译出与 .wxss 等价的 css', async () => {
		const pagePath = 'pages/sty/index'
		prepareSkeleton(pagePath)
		// 页面提供 .qdml 模板 + .qdss 样式（含一条简单到不会被优化掉的规则）
		writeProjectFile(`${pagePath}.qdml`, '<view class="brand">home</view>')
		writeProjectFile(`${pagePath}.qdss`, '.brand { color: red; }')

		const outputDir = setTargetPath()

		const { storeInfo: store, getPages } = await import('../src/env.js')
		store(tempDir, { fileTypes: { template: ['qdml'], style: ['qdss'] } })

		const { compileSS } = await import('../src/core/style-compiler.js')
		await compileSS(getPages().mainPages, null, { completedTasks: 0 })

		const outputPath = path.join(outputDir, 'main/pages_sty_index.css')
		expect(fs.existsSync(outputPath)).toBe(true)

		const output = fs.readFileSync(outputPath, 'utf-8')
		// 特征：选择器与声明都必须出现（允许压缩去空格）
		expect(output).toContain('.brand')
		expect(output).toMatch(/color\s*:\s*red/)
	})

	// bug：viewScript 注入只更新扩展名/标签但 view-compiler 未消费 → .qds 文件 &
	// 内联 <qds module> 标签均不被当 WXS 类脚本编译进产物
	it('.qds 文件与内联 <qds> 标签被当作 WXS 类脚本编译', async () => {
		const pagePath = 'pages/vs/index'
		prepareSkeleton(pagePath)
		// 内联 <qds module="m1"> 导出函数；同时 src 引用外部 .qds 文件
		writeProjectFile(`${pagePath}.qdml`, `
<qds module="m1">
	function inlineFn(text) {
		return text + ' from inline qds'
	}
	module.exports = { inlineFn: inlineFn }
</qds>
<qds module="m2" src="./util.qds" />
<view>
	<text>{{m1.inlineFn('Hi')}}</text>
	<text>{{m2.srcFn('Hi')}}</text>
</view>
		`)
		writeProjectFile('pages/vs/util.qds', `
function srcFn(text) {
	return text + ' from src qds'
}
module.exports = { srcFn: srcFn }
		`)

		const outputDir = setTargetPath()

		const { storeInfo: store, getPages } = await import('../src/env.js')
		store(tempDir, { fileTypes: { template: ['qdml'], viewScript: ['qds'] } })

		const { compileML } = await import('../src/core/view-compiler.js')
		await compileML(getPages().mainPages, null, { completedTasks: 0 })

		const outputPath = path.join(outputDir, 'main/pages_vs_index.js')
		expect(fs.existsSync(outputPath)).toBe(true)

		const output = fs.readFileSync(outputPath, 'utf-8')
		// 内联 <qds module="m1"> → 以模块名 m1 注册（与 <wxs module> 等价形态）
		expect(output).toContain('modDefine("m1"')
		expect(output).toContain('inlineFn')
		expect(output).toContain('from inline qds')
		// src 引用的 .qds 文件 → 以文件路径派生 id 注册（与 <wxs src> 等价形态）。
		// 与内联模块不同，src 模块用 util.qds 的路径名 pages_vs_util，而非标签上的 m2。
		expect(output).toContain('modDefine("pages_vs_util"')
		expect(output).toContain('srcFn')
		expect(output).toContain('from src qds')
		// 页面 render 通过依赖注入引用这两个 qds 模块（证明 .qds + <qds> 被当 WXS 类脚本编进来了）
		expect(output).toContain('"m1"')
		expect(output).toContain('"pages_vs_util"')
		// WXS 类脚本特征：exports（压缩后可能是 t.exports / module.exports / n.exports 等）
		expect(output).toMatch(/\w\.exports/)
	})

	// brand 前缀指令：编译器按指令后缀(:if/:for/:key…)匹配、与前缀无关，所以 .qdml 里写
	// qd:if / qd:for 会和 wx:if / wx:for 一样编成 v-if / v-for。守住「不得硬编码 wx: 前缀」。
	it('.qdml 里的 qd: 前缀指令（if/else/for/for-item/for-index/key）按 v-if/v-for 编译', async () => {
		const pagePath = 'pages/dir/index'
		prepareSkeleton(pagePath)
		writeProjectFile(`${pagePath}.js`, 'Page({ data: { show: true, list: [{ id: 1, name: "a" }] } })')
		writeProjectFile(`${pagePath}.qdml`, [
			'<view qd:if="{{ show }}">on</view>',
			'<view qd:else>off</view>',
			'<view qd:for="{{ list }}" qd:for-item="it" qd:for-index="idx" qd:key="id">{{ idx }}:{{ it.name }}</view>',
		].join('\n'))

		const outputDir = setTargetPath()

		const { storeInfo: store, getPages } = await import('../src/env.js')
		store(tempDir, { fileTypes: { template: ['qdml'] } })

		const { compileML } = await import('../src/core/view-compiler.js')
		await compileML(getPages().mainPages, null, { completedTasks: 0 })

		const output = fs.readFileSync(path.join(outputDir, 'main/pages_dir_index.js'), 'utf-8')
		// qd:if/qd:else → 条件分支：以 show 为条件的三元块
		expect(output).toContain('show')
		expect(output).toMatch(/\?\(_openBlock/)
		// qd:for → v-for 经 _renderList 展开 list
		expect(output).toContain('_renderList')
		expect(output).toContain('list')
		// qd:key → 列表项 key 绑定
		expect(output).toMatch(/key:/)
	})
})
