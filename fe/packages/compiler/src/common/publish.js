import path from 'node:path'
import process from 'node:process'
import fs from 'node:fs'
import { getAppId, getTargetPath, isTemporaryTargetPath } from '../env.js'

function copyDir(src, dest) {
	fs.mkdirSync(dest, { recursive: true })
	for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
		const srcPath = path.join(src, entry.name)
		const destPath = path.join(dest, entry.name)
		if (entry.isDirectory()) {
			copyDir(srcPath, destPath)
		}
		else {
			// APFS/Btrfs 等支持时创建写时复制克隆；不支持时 Node 自动回退为普通复制。
			fs.copyFileSync(srcPath, destPath, fs.constants.COPYFILE_FICLONE)
		}
	}
}

function createDist(seedPath) {
	const distPath = getTargetPath()
	if (fs.existsSync(distPath)) {
		fs.rmSync(distPath, { recursive: true, force: true })
	}
	fs.mkdirSync(distPath, { recursive: true })
	if (seedPath && fs.existsSync(seedPath)) {
		copyDir(seedPath, distPath)
	}
}
/**
 * 发布到指定目录
 * @param {string} dist 目标路径
 * @param {boolean} useAppIdDir 是否在路径中包含appId
 */
function publishToDist(dist, useAppIdDir = true) {
	const distPath = getTargetPath()
	const appId = getAppId()
	const absolutePath = useAppIdDir
		? `${path.resolve(process.cwd(), dist)}${path.sep}${appId}`
		: `${path.resolve(process.cwd(), dist)}`
	
	if (path.resolve(distPath) === path.resolve(absolutePath)) {
		return
	}

	if (fs.existsSync(absolutePath)) {
		fs.rmSync(absolutePath, { recursive: true, force: true })
	}
	fs.mkdirSync(path.dirname(absolutePath), { recursive: true })

	// 默认构建目录由编译器独占，并且通常与发布目录位于同一磁盘。
	// 直接移动可避免把 npm、静态资源和三阶段产物完整复制第二遍。
	if (isTemporaryTargetPath()) {
		try {
			fs.renameSync(distPath, absolutePath)
			return
		}
		catch (error) {
			if (error.code !== 'EXDEV') {
				throw error
			}
			// 跨文件系统时保留原有复制语义，复制完成后清理编译器临时目录。
			fs.mkdirSync(absolutePath, { recursive: true })
			copyDir(distPath, absolutePath)
			fs.rmSync(distPath, { recursive: true, force: true })
			return
		}
	}

	fs.mkdirSync(absolutePath, { recursive: true })

	copyDir(distPath, absolutePath)
}

export { createDist, publishToDist }
