// @vitest-environment node
//
// 纯粹的文件系统静态扫描，不需要 DOM；显式切到 node 环境，避免 jsdom 环境下
// import.meta.url 被改写成非 file: scheme 的地址导致 fileURLToPath 抛错。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// 契约行为 7：container-sdk 包源码不能 import fe/packages/container 这个 demo 的
// @/services、AppList、Device——SDK 必须自己实现（或注入）小程序元信息与状态栏
// shell 的能力，不能偷懒直接复用宿主 demo 的实现。这是对 src/ 做静态扫描的断言，
// 不依赖任何具体导出，src/ 目录本身不存在时应当直接失败。
const SRC_DIR = fileURLToPath(new URL('../src', import.meta.url))

const FORBIDDEN_SPECIFIER_PATTERNS = [
	/@\/services/i,
	/\bappList(\.js)?['"]?$/i,
	/\/appList\//i,
	/\/pages\/device\b/i,
	/\/device(\.js)?['"]?$/i,
	/packages\/container\//i,
]

function collectSourceFiles(dir: string): string[] {
	const entries = fs.readdirSync(dir, { withFileTypes: true })
	return entries.flatMap((entry) => {
		const full = path.join(dir, entry.name)
		if (entry.isDirectory()) {
			return collectSourceFiles(full)
		}
		// container-sdk 源码已从 .js 迁移到 .ts，扫描的文件类型跟随迁移同步扩展，
		// 断言本身（无禁止 specifier）不变。
		if (/\.(?:js|mjs|cjs|ts|vue)$/.test(entry.name)) {
			return [full]
		}
		return []
	})
}

function findImportSpecifiers(content: string): string[] {
	const specifiers: string[] = []
	const importRe = /import\s+(?:[\w*{}\s,]+\s+from\s+)?['"]([^'"]+)['"]/g
	const dynamicImportRe = /import\(\s*['"]([^'"]+)['"]\s*\)/g
	let match: RegExpExecArray | null
	// eslint-disable-next-line no-cond-assign
	while ((match = importRe.exec(content))) {
		specifiers.push(match[1])
	}
	// eslint-disable-next-line no-cond-assign
	while ((match = dynamicImportRe.exec(content))) {
		specifiers.push(match[1])
	}
	return specifiers
}

describe('container-sdk source has no demo dependency', () => {
	it('does not import @/services, AppList, or Device from the container demo', () => {
		const files = collectSourceFiles(SRC_DIR)
		expect(files.length).toBeGreaterThan(0)

		const offenders: string[] = []
		for (const file of files) {
			const content = fs.readFileSync(file, 'utf8')
			for (const specifier of findImportSpecifiers(content)) {
				if (FORBIDDEN_SPECIFIER_PATTERNS.some(pattern => pattern.test(specifier))) {
					offenders.push(`${path.relative(SRC_DIR, file)}: "${specifier}"`)
				}
			}
		}

		expect(offenders).toEqual([])
	})
})
