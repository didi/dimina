import { describe, expect, it } from 'vitest'
import {
	getFsPathApi,
	getRelativePosixPath,
	resolveMiniProgramPath,
	toMiniProgramModuleId,
} from '../src/common/path-utils.js'

describe('path utils', () => {
	it('应该根据输入路径语义选择 Windows path API', () => {
		expect(getFsPathApi('E:\\WeChatProjects\\Demo\\app.json').sep).toBe('\\')
	})

	it('应该根据输入路径语义选择 POSIX path API', () => {
		expect(getFsPathApi('/Users/doslin/project/app.json').sep).toBe('/')
	})

	it('应该解析 Windows 风格的小程序绝对路径', () => {
		const workPath = 'E:\\WeChatProjects\\Demo'
		const importerPath = 'E:\\WeChatProjects\\Demo\\pages\\index\\index.json'

		expect(resolveMiniProgramPath(workPath, importerPath, '/components/navigation-bar/navigation-bar')).toBe(
			'E:\\WeChatProjects\\Demo\\components\\navigation-bar\\navigation-bar',
		)
	})

	it('应该将文件系统路径稳定转换为小程序模块 id', () => {
		const workPath = 'E:\\WeChatProjects\\Demo'
		const resolvedPath = 'E:\\WeChatProjects\\Demo\\components\\navigation-bar\\navigation-bar'

		expect(toMiniProgramModuleId(resolvedPath, workPath)).toBe('/components/navigation-bar/navigation-bar')
	})

	it('应该生成稳定的 POSIX 相对路径用于 npm 搜索', () => {
		const workPath = 'E:\\WeChatProjects\\Demo'
		const filePath = 'E:\\WeChatProjects\\Demo\\pages\\subpackage\\detail\\index.js'

		expect(getRelativePosixPath(filePath, workPath)).toBe('pages/subpackage/detail/index.js')
	})
})
