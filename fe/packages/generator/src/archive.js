import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { parseProject, validateFiles } from './protocol.js'

const MAX_IMPORT_BYTES = 2 * 1024 * 1024
const MAX_ARCHIVE_BYTES = 1024 * 1024 + 64 * 1024
const unsafeParts = new Set(['', '.', '..', '__proto__', 'constructor', 'prototype'])

/** Export real project files, never model settings, conversation history or runtime data. */
export function createSourceArchive(project, edits = {}) {
	validateFiles(project.files)
	const files = Object.fromEntries(Object.entries(project.files).map(([path, text]) => [path, edits[path] ?? text]))
	if (Object.values(files).some(text => typeof text !== 'string')) throw new Error('导出的源码内容必须是字符串')
	const name = project.name || '我的小程序'
	const config = {
		appid: project.id || 'dimina-generated', projectname: encodeURIComponent(name),
		compileType: 'miniprogram', miniprogramRoot: './',
		setting: { es6: true, postcss: true, minified: true },
	}
	const contents = {
		...files,
		'project.config.json': JSON.stringify(config, null, 2),
		'README.md': `# ${name}\n\n这是通过 Dimina Web 创建的小程序源码项目，目录结构与生成时保持一致。\n\n## 本地编译\n\n在项目目录中执行：\n\n\`\`\`sh\nnpx @dimina/compiler build -c . -s ./dist\n\`\`\`\n\n使用其他开发工具时，请按需调整 project.config.json 中的 appid 等项目配置。\n`,
	}
	const filename = name.replace(/[<>:"/\\|?*]/g, '-').replace(/\p{Cc}/gu, '').trim().replace(/[. ]+$/, '') || 'mini-program'
	return { filename: `${filename}.zip`, data: zipSync(Object.fromEntries(Object.entries(contents).map(([path, text]) => [path, strToU8(text)]))) }
}

/** Read exported ZIP projects, or the JSON format accepted by earlier versions. */
export async function readSourceProject(file) {
	if (file.size > MAX_IMPORT_BYTES) throw new Error('导入文件不能超过 2 MiB')
	const bytes = new Uint8Array(await file.arrayBuffer())
	if (bytes.length > MAX_IMPORT_BYTES) throw new Error('导入文件不能超过 2 MiB')
	const zip = /\.zip$/i.test(file.name || '') || file.type === 'application/zip' || (bytes[0] === 0x50 && bytes[1] === 0x4B && bytes[2] === 3 && bytes[3] === 4)
	if (!zip) return parseProject(new TextDecoder('utf-8', { fatal: true }).decode(bytes))

	let size = 0, count = 0
	const paths = new Set()
	const entries = unzipSync(bytes, { filter(entry) {
		const path = entry.name.endsWith('/') ? entry.name.slice(0, -1) : entry.name
		if (path.startsWith('/') || path.includes('\\') || path.includes(':') || path.includes('\0') || path.split('/').some(part => unsafeParts.has(part))) throw new Error(`ZIP 中包含不安全的路径：${entry.name}`)
		if (paths.has(entry.name)) throw new Error(`ZIP 中包含重复文件：${entry.name}`)
		paths.add(entry.name)
		if (paths.size > 200) throw new Error('ZIP 中的目录及文件数量过多')
		if (entry.name.endsWith('/')) return false
		if (++count > 82) throw new Error('ZIP 最多支持 80 个源码文件及项目配置、说明文件')
		size += entry.originalSize
		if (!Number.isSafeInteger(size) || size > MAX_ARCHIVE_BYTES) throw new Error('ZIP 解压后的源码和配置超过大小限制')
		return true
	} })
	const roots = entries['app.json'] ? ['app.json'] : Object.keys(entries).filter(path => path.endsWith('/app.json'))
	if (roots.length !== 1) throw new Error('ZIP 中应包含一个完整小程序项目及其 app.json')
	const prefix = roots[0].slice(0, -'app.json'.length)
	const files = {}
	let name = (file.name || '').replace(/\.zip$/i, '') || '我的小程序'
	for (const [path, bytes] of Object.entries(entries)) {
		if (!path.startsWith(prefix)) throw new Error('ZIP 中包含小程序项目目录以外的文件')
		const relative = path.slice(prefix.length)
		if (relative === 'README.md') continue
		if (relative === 'project.config.json') {
			const config = JSON.parse(strFromU8(bytes))
			if (typeof config.projectname === 'string') {
				try { name = decodeURIComponent(config.projectname) } catch { name = config.projectname }
			}
			continue
		}
		files[relative] = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
	}
	return parseProject({ name, files })
}
