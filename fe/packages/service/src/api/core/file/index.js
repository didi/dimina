import { invokeAPI } from '@/api/common'

/**
 * 文件系统管理器
 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.html
 */
class FileSystemManager {
	/**
	 * 判断文件/目录是否存在
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.access.html
	 */
	access(opts) {
		invokeAPI('FileSystemManager.access', opts)
	}

	/**
	 * 同步判断文件/目录是否存在
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.accessSync.html
	 */
	accessSync(path) {
		return invokeAPI('FileSystemManager.accessSync', path)
	}

	/**
	 * 在文件结尾追加内容
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.appendFile.html
	 */
	appendFile(opts) {
		invokeAPI('FileSystemManager.appendFile', opts)
	}

	/**
	 * 同步在文件结尾追加内容
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.appendFileSync.html
	 */
	appendFileSync(filePath, data, encoding) {
		return invokeAPI('FileSystemManager.appendFileSync', { filePath, data, encoding })
	}

	/**
	 * 关闭文件
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.close.html
	 */
	close(opts) {
		invokeAPI('FileSystemManager.close', opts)
	}

	/**
	 * 同步关闭文件
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.closeSync.html
	 */
	closeSync(opts) {
		return invokeAPI('FileSystemManager.closeSync', opts)
	}

	/**
	 * 复制文件
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.copyFile.html
	 */
	copyFile(opts) {
		invokeAPI('FileSystemManager.copyFile', opts)
	}

	/**
	 * 同步复制文件
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.copyFileSync.html
	 */
	copyFileSync(srcPath, destPath) {
		return invokeAPI('FileSystemManager.copyFileSync', { srcPath, destPath })
	}

	/**
	 * 获取文件的状态信息
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.fstat.html
	 */
	fstat(opts) {
		invokeAPI('FileSystemManager.fstat', opts)
	}

	/**
	 * 同步获取文件的状态信息
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.fstatSync.html
	 */
	fstatSync(opts) {
		return invokeAPI('FileSystemManager.fstatSync', opts)
	}

	/**
	 * 对文件内容进行截断操作
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.ftruncate.html
	 */
	ftruncate(opts) {
		invokeAPI('FileSystemManager.ftruncate', opts)
	}

	/**
	 * 对文件内容进行截断操作(同步)
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.ftruncateSync.html
	 */
	ftruncateSync(opts) {
		return invokeAPI('FileSystemManager.ftruncateSync', opts)
	}

	/**
	 * 获取该小程序下的本地临时文件或本地缓存文件信息
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.getFileInfo.html
	 */
	getFileInfo(opts) {
		invokeAPI('FileSystemManager.getFileInfo', opts)
	}

	/**
	 * 获取该小程序下已保存的本地缓存文件列表
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.getSavedFileList.html
	 */
	getSavedFileList(opts) {
		invokeAPI('FileSystemManager.getSavedFileList', opts)
	}

	/**
	 * 创建目录
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.mkdir.html
	 */
	mkdir(opts) {
		invokeAPI('FileSystemManager.mkdir', opts)
	}

	/**
	 * 同步创建目录
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.mkdirSync.html
	 */
	mkdirSync(dirPath, recursive) {
		return invokeAPI('FileSystemManager.mkdirSync', { dirPath, recursive })
	}

	/**
	 * 打开文件,返回文件描述符
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.open.html
	 */
	open(opts) {
		invokeAPI('FileSystemManager.open', opts)
	}

	/**
	 * 同步打开文件,返回文件描述符
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.openSync.html
	 */
	openSync(opts) {
		return invokeAPI('FileSystemManager.openSync', opts)
	}

	/**
	 * 读文件
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.read.html
	 */
	read(opts) {
		invokeAPI('FileSystemManager.read', opts)
	}

	/**
	 * 读文件(同步)
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.readSync.html
	 */
	readSync(opts) {
		return invokeAPI('FileSystemManager.readSync', opts)
	}

	/**
	 * 读取指定压缩类型的本地文件内容
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.readCompressedFile.html
	 */
	readCompressedFile(opts) {
		invokeAPI('FileSystemManager.readCompressedFile', opts)
	}

	/**
	 * 同步读取指定压缩类型的本地文件内容
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.readCompressedFileSync.html
	 */
	readCompressedFileSync(opts) {
		return invokeAPI('FileSystemManager.readCompressedFileSync', opts)
	}

	/**
	 * 读取目录内文件列表
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.readdir.html
	 */
	readdir(opts) {
		invokeAPI('FileSystemManager.readdir', opts)
	}

	/**
	 * 同步读取目录内文件列表
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.readdirSync.html
	 */
	readdirSync(dirPath) {
		return invokeAPI('FileSystemManager.readdirSync', dirPath)
	}

	/**
	 * 读取本地文件内容
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.readFile.html
	 */
	readFile(opts) {
		invokeAPI('FileSystemManager.readFile', opts)
	}

	/**
	 * 同步读取本地文件内容
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.readFileSync.html
	 */
	readFileSync(filePath, encoding, position, length) {
		return invokeAPI('FileSystemManager.readFileSync', { filePath, encoding, position, length })
	}

	/**
	 * 读取压缩包内的文件
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.readZipEntry.html
	 */
	readZipEntry(opts) {
		invokeAPI('FileSystemManager.readZipEntry', opts)
	}

	/**
	 * 删除该小程序下已保存的本地缓存文件
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.removeSavedFile.html
	 */
	removeSavedFile(opts) {
		invokeAPI('FileSystemManager.removeSavedFile', opts)
	}

	/**
	 * 重命名文件。可以把文件从 oldPath 移动到 newPath
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.rename.html
	 */
	rename(opts) {
		invokeAPI('FileSystemManager.rename', opts)
	}

	/**
	 * 同步重命名文件
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.renameSync.html
	 */
	renameSync(oldPath, newPath) {
		return invokeAPI('FileSystemManager.renameSync', { oldPath, newPath })
	}

	/**
	 * 删除目录
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.rmdir.html
	 */
	rmdir(opts) {
		invokeAPI('FileSystemManager.rmdir', opts)
	}

	/**
	 * 同步删除目录
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.rmdirSync.html
	 */
	rmdirSync(dirPath, recursive) {
		return invokeAPI('FileSystemManager.rmdirSync', { dirPath, recursive })
	}

	/**
	 * 保存临时文件到本地
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.saveFile.html
	 */
	saveFile(opts) {
		invokeAPI('FileSystemManager.saveFile', opts)
	}

	/**
	 * 同步保存临时文件到本地
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.saveFileSync.html
	 */
	saveFileSync(tempFilePath, filePath) {
		return invokeAPI('FileSystemManager.saveFileSync', { tempFilePath, filePath })
	}

	/**
	 * 获取文件 Stats 对象
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.stat.html
	 */
	stat(opts) {
		invokeAPI('FileSystemManager.stat', opts)
	}

	/**
	 * 同步获取文件 Stats 对象
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.statSync.html
	 */
	statSync(path, recursive) {
		return invokeAPI('FileSystemManager.statSync', { path, recursive })
	}

	/**
	 * 对文件内容进行截断操作
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.truncate.html
	 */
	truncate(opts) {
		invokeAPI('FileSystemManager.truncate', opts)
	}

	/**
	 * 对文件内容进行截断操作(同步)
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.truncateSync.html
	 */
	truncateSync(filePath, length) {
		return invokeAPI('FileSystemManager.truncateSync', { filePath, length })
	}

	/**
	 * 删除文件
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.unlink.html
	 */
	unlink(opts) {
		invokeAPI('FileSystemManager.unlink', opts)
	}

	/**
	 * 同步删除文件
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.unlinkSync.html
	 */
	unlinkSync(filePath) {
		return invokeAPI('FileSystemManager.unlinkSync', filePath)
	}

	/**
	 * 解压文件
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.unzip.html
	 */
	unzip(opts) {
		invokeAPI('FileSystemManager.unzip', opts)
	}

	/**
	 * 写入文件
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.write.html
	 */
	write(opts) {
		invokeAPI('FileSystemManager.write', opts)
	}

	/**
	 * 同步写入文件
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.writeSync.html
	 */
	writeSync(opts) {
		return invokeAPI('FileSystemManager.writeSync', opts)
	}

	/**
	 * 写文件
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.writeFile.html
	 */
	writeFile(opts) {
		invokeAPI('FileSystemManager.writeFile', opts)
	}

	/**
	 * 同步写文件
	 * https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.writeFileSync.html
	 */
	writeFileSync(filePath, data, encoding) {
		return invokeAPI('FileSystemManager.writeFileSync', { filePath, data, encoding })
	}
}

let fileSystemManagerInstance = null

/**
 * 获取全局唯一的文件管理器
 * https://developers.weixin.qq.com/miniprogram/dev/api/file/wx.getFileSystemManager.html
 */
export function getFileSystemManager() {
	if (!fileSystemManagerInstance) {
		fileSystemManagerInstance = new FileSystemManager()
	}
	return fileSystemManagerInstance
}
