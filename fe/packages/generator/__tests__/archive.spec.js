import { describe, expect, it } from 'vitest'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { createSourceArchive, readSourceProject } from '../src/archive.js'

const project = { id: 'generated-example', name: '待办清单 100%', files: {
	'app.js': 'App({})', 'app.json': '{"pages":["pages/index"]}', 'app.wxss': 'page { color: #123; }',
	'pages/index.js': 'Page({data:{title:"你好"}})', 'pages/index.wxml': '<view>{{title}}</view>', 'pages/index.wxss': 'view { padding: 20rpx; }',
	'utils/date.js': 'module.exports = () => "今天"',
	'components/item/index.json': '{"component":true}', 'components/item/index.js': 'Component({})',
	'components/item/index.wxml': '<text>条目</text>',
}, resources: { 'main/logic.js': 'compiled-runtime' }, messages: [{ role: 'user', content: 'private-conversation' }], token: 'private-token' }
const zipFile = (data, name = 'project.zip') => new File([data], name, { type: 'application/zip' })

describe('complete source projects', () => {
	it('exports every source file with original paths and UTF-8 contents plus project configuration', () => {
		const archive = createSourceArchive(project)
		expect(archive.filename).toBe('待办清单 100%.zip')
		const entries = unzipSync(archive.data)
		expect(Object.keys(entries).sort()).toEqual([...Object.keys(project.files), 'project.config.json', 'README.md'].sort())
		for (const [path, text] of Object.entries(project.files)) expect(strFromU8(entries[path])).toBe(text)
		expect(JSON.parse(strFromU8(entries['project.config.json']))).toMatchObject({ appid: project.id, projectname: encodeURIComponent(project.name), compileType: 'miniprogram', miniprogramRoot: './' })
		expect(Object.values(entries).map(data => strFromU8(data)).join('\n')).not.toMatch(/private-token|private-conversation|compiled-runtime/)
	})
	it('round trips an exported ZIP, keeping application files separate from editor configuration', async () => {
		const archive = createSourceArchive(project)
		expect(await readSourceProject(zipFile(archive.data, archive.filename))).toEqual({ name: project.name, files: project.files })
	})
	it('includes unfinished editor drafts without mutating the saved project', () => {
		const archive = createSourceArchive(project, { 'app.json': '{', 'utils/date.js': '未完成的源码' })
		const entries = unzipSync(archive.data)
		expect(strFromU8(entries['app.json'])).toBe('{')
		expect(strFromU8(entries['utils/date.js'])).toBe('未完成的源码')
		expect(project.files['app.json']).toBe('{"pages":["pages/index"]}')
	})
	it('accepts a project inside one directory and keeps legacy JSON imports working', async () => {
		const entries = unzipSync(createSourceArchive(project).data)
		const wrapped = zipSync(Object.fromEntries(Object.entries(entries).map(([path, data]) => [`小程序/${path}`, data])))
		expect(await readSourceProject(zipFile(wrapped))).toEqual({ name: project.name, files: project.files })
		expect(await readSourceProject(new File([JSON.stringify(project)], 'source.json'))).toEqual({ name: project.name, files: project.files })
	})
	it.each(['../outside.js', '/absolute.js', 'dir/../../outside.js', '__proto__/bad.js', 'dir\\outside.js'])('rejects unsafe archive paths before decompressing: %s', async path => {
		const data = zipSync({ [path]: strToU8('') })
		await expect(readSourceProject(zipFile(data))).rejects.toThrow('不安全的路径')
	})
	it('rejects oversized expanded files even when the compressed input is small', async () => {
		const data = zipSync({ 'huge.js': strToU8('a'.repeat(1024 * 1024 + 64 * 1024 + 1)) })
		expect(data.length).toBeLessThan(10000)
		await expect(readSourceProject(zipFile(data))).rejects.toThrow('解压后的源码和配置超过大小限制')
	})
	it('rejects incomplete projects and preserves invalid source validation', async () => {
		await expect(readSourceProject(zipFile(zipSync({ 'file.js': strToU8('') })))).rejects.toThrow('完整小程序项目')
		const entries = unzipSync(createSourceArchive(project).data)
		entries['app.json'] = strToU8('{')
		await expect(readSourceProject(zipFile(zipSync(entries)))).rejects.toThrow('有效 JSON')
	})
})
