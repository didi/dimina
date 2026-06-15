package com.didi.dimina.api.file

import android.util.Base64
import com.didi.dimina.api.APIResult
import com.didi.dimina.api.AsyncResult
import com.didi.dimina.api.BaseApiHandler
import com.didi.dimina.api.SyncResult
import com.didi.dimina.engine.qjs.JSValue
import com.didi.dimina.ui.container.DiminaActivity
import org.brotli.dec.BrotliInputStream
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.security.MessageDigest
import java.util.UUID
import java.util.zip.ZipFile

class FileApi : BaseApiHandler() {
    private companion object {
        const val SAVE_FILE_TO_DISK = "saveFileToDisk"
        const val PREFIX = "FileSystemManager."
        const val VIRTUAL_PREFIX = "difile://"
        const val USER_PREFIX = "usr"
        const val TEMP_PREFIX = "tmp"
        const val ARRAY_BUFFER_BASE64_KEY = "__diminaArrayBufferBase64"
        const val FILE_DATA_BASE64_KEY = "__diminaFileDataBase64"
        const val FILE_DATA_TYPE_KEY = "__diminaFileDataType"

        data class OpenFile(val file: File, val handle: RandomAccessFile)

        val OPEN_FILES = mutableMapOf<String, OpenFile>()
    }

    override val apiNames = setOf(
        SAVE_FILE_TO_DISK,
        "FileSystemManager.access",
        "FileSystemManager.accessSync",
        "FileSystemManager.appendFile",
        "FileSystemManager.appendFileSync",
        "FileSystemManager.close",
        "FileSystemManager.closeSync",
        "FileSystemManager.copyFile",
        "FileSystemManager.copyFileSync",
        "FileSystemManager.fstat",
        "FileSystemManager.fstatSync",
        "FileSystemManager.ftruncate",
        "FileSystemManager.ftruncateSync",
        "FileSystemManager.getFileInfo",
        "FileSystemManager.getSavedFileList",
        "FileSystemManager.mkdir",
        "FileSystemManager.mkdirSync",
        "FileSystemManager.open",
        "FileSystemManager.openSync",
        "FileSystemManager.read",
        "FileSystemManager.readSync",
        "FileSystemManager.readCompressedFile",
        "FileSystemManager.readCompressedFileSync",
        "FileSystemManager.readdir",
        "FileSystemManager.readdirSync",
        "FileSystemManager.readFile",
        "FileSystemManager.readFileSync",
        "FileSystemManager.readZipEntry",
        "FileSystemManager.removeSavedFile",
        "FileSystemManager.rename",
        "FileSystemManager.renameSync",
        "FileSystemManager.rmdir",
        "FileSystemManager.rmdirSync",
        "FileSystemManager.saveFile",
        "FileSystemManager.saveFileSync",
        "FileSystemManager.stat",
        "FileSystemManager.statSync",
        "FileSystemManager.truncate",
        "FileSystemManager.truncateSync",
        "FileSystemManager.unlink",
        "FileSystemManager.unlinkSync",
        "FileSystemManager.unzip",
        "FileSystemManager.write",
        "FileSystemManager.writeSync",
        "FileSystemManager.writeFile",
        "FileSystemManager.writeFileSync",
    )

    override fun handleAction(
        activity: DiminaActivity,
        appId: String,
        apiName: String,
        params: JSONObject,
        responseCallback: (String) -> Unit,
    ): APIResult {
        if (apiName == SAVE_FILE_TO_DISK) {
            return fail(apiName, "not supported on this platform")
        }

        return try {
            when (apiName.removePrefix(PREFIX)) {
                "access" -> asyncOkOrFail(apiName) { accessSync(activity, appId, pathParam(params)); JSONObject() }
                "accessSync" -> syncVoid { accessSync(activity, appId, stringParam(params, "path")) }
                "appendFile" -> asyncOkOrFail(apiName) { appendFileSync(activity, appId, params); JSONObject() }
                "appendFileSync" -> syncVoid { appendFileSync(activity, appId, params) }
                "close" -> asyncOkOrFail(apiName) { closeSync(params); JSONObject() }
                "closeSync" -> syncVoid { closeSync(params) }
                "copyFile" -> asyncOkOrFail(apiName) { copyFileSync(activity, appId, params); JSONObject() }
                "copyFileSync" -> syncVoid { copyFileSync(activity, appId, params) }
                "fstat" -> asyncOkOrFail(apiName) { JSONObject().put("stats", fstatSync(params)) }
                "fstatSync" -> SyncResult(JSValue.createObject(fstatSync(params).toString()))
                "ftruncate" -> asyncOkOrFail(apiName) { ftruncateSync(params); JSONObject() }
                "ftruncateSync" -> syncVoid { ftruncateSync(params) }
                "getFileInfo" -> asyncOkOrFail(apiName) { getFileInfo(activity, appId, params) }
                "getSavedFileList" -> asyncOkOrFail(apiName) { getSavedFileList(activity, appId) }
                "mkdir" -> asyncOkOrFail(apiName) { mkdirSync(activity, appId, params); JSONObject() }
                "mkdirSync" -> syncVoid { mkdirSync(activity, appId, params) }
                "open" -> asyncOkOrFail(apiName) { JSONObject().put("fd", openSync(activity, appId, params)) }
                "openSync" -> SyncResult(JSValue.createString(openSync(activity, appId, params)))
                "read" -> asyncOkOrFail(apiName) { readSync(params) }
                "readSync" -> SyncResult(JSValue.createObject(readSync(params).toString()))
                "readCompressedFile" -> asyncOkOrFail(apiName) { JSONObject().put("data", readCompressedFileSync(activity, appId, params)) }
                "readCompressedFileSync" -> SyncResult(JSValue.createObject(readCompressedFileSync(activity, appId, params).toString()))
                "readdir" -> asyncOkOrFail(apiName) { JSONObject().put("files", readdirSync(activity, appId, pathParam(params))) }
                "readdirSync" -> SyncResult(JSValue.createObject(readdirSync(activity, appId, stringParam(params, "dirPath")).toString()))
                "readFile" -> asyncOkOrFail(apiName) { JSONObject().put("data", readFileSync(activity, appId, params)) }
                "readFileSync" -> toSyncValue(readFileSync(activity, appId, params))
                "readZipEntry" -> asyncOkOrFail(apiName) { readZipEntry(activity, appId, params) }
                "removeSavedFile" -> asyncOkOrFail(apiName) { unlinkPath(activity, appId, pathParam(params)); JSONObject() }
                "rename" -> asyncOkOrFail(apiName) { renameSync(activity, appId, params); JSONObject() }
                "renameSync" -> syncVoid { renameSync(activity, appId, params) }
                "rmdir" -> asyncOkOrFail(apiName) { rmdirSync(activity, appId, params); JSONObject() }
                "rmdirSync" -> syncVoid { rmdirSync(activity, appId, params) }
                "saveFile" -> asyncOkOrFail(apiName) { JSONObject().put("savedFilePath", saveFileSync(activity, appId, params)) }
                "saveFileSync" -> SyncResult(JSValue.createString(saveFileSync(activity, appId, params)))
                "stat" -> asyncOkOrFail(apiName) { JSONObject().put("stats", statSync(activity, appId, params)) }
                "statSync" -> SyncResult(JSValue.createObject(statSync(activity, appId, params).toString()))
                "truncate" -> asyncOkOrFail(apiName) { truncateSync(activity, appId, params); JSONObject() }
                "truncateSync" -> syncVoid { truncateSync(activity, appId, params) }
                "unlink" -> asyncOkOrFail(apiName) { unlinkPath(activity, appId, pathParam(params)); JSONObject() }
                "unlinkSync" -> syncVoid { unlinkPath(activity, appId, stringParam(params, "filePath")) }
                "unzip" -> asyncOkOrFail(apiName) { unzip(activity, appId, params); JSONObject() }
                "write" -> asyncOkOrFail(apiName) { writeSync(params) }
                "writeSync" -> SyncResult(JSValue.createObject(writeSync(params).toString()))
                "writeFile" -> asyncOkOrFail(apiName) { writeFileSync(activity, appId, params); JSONObject() }
                "writeFileSync" -> syncVoid { writeFileSync(activity, appId, params) }
                else -> super.handleAction(activity, appId, apiName, params, responseCallback)
            }
        } catch (e: Exception) {
            if (apiName.endsWith("Sync")) {
                SyncResult(JSValue.createError("$apiName:fail ${e.message ?: "operation failed"}"))
            } else {
                fail(apiName, e.message ?: "operation failed")
            }
        }
    }

    private fun asyncOkOrFail(apiName: String, block: () -> JSONObject): APIResult {
        val data = block()
        data.put("errMsg", "$apiName:ok")
        return AsyncResult(data)
    }

    private fun fail(apiName: String, message: String): APIResult =
        AsyncResult(JSONObject().put("errMsg", "$apiName:fail $message"))

    private fun syncVoid(block: () -> Unit): APIResult {
        block()
        return SyncResult(JSValue.createUndefined())
    }

    private fun toSyncValue(value: Any): APIResult =
        when (value) {
            is JSONObject -> SyncResult(JSValue.createObject(value.toString()))
            is JSONArray -> SyncResult(JSValue.createObject(value.toString()))
            is String -> SyncResult(JSValue.createString(value))
            is Boolean -> SyncResult(JSValue.createBoolean(value))
            is Number -> SyncResult(JSValue.createNumber(value.toDouble()))
            else -> SyncResult(JSValue.createUndefined())
        }

    private fun userRoot(activity: DiminaActivity, appId: String): File =
        File(activity.filesDir, "dimina-file-system/$appId/$USER_PREFIX").apply { mkdirs() }

    private fun tempRoot(activity: DiminaActivity): File =
        activity.cacheDir.apply { mkdirs() }

    private fun resolve(activity: DiminaActivity, appId: String, rawPath: String): File {
        val path = rawPath.ifBlank { throw IllegalArgumentException("missing file path") }
        val file = if (path.startsWith(VIRTUAL_PREFIX)) {
            val relative = path.removePrefix(VIRTUAL_PREFIX).trimStart('/')
            when {
                relative == USER_PREFIX -> userRoot(activity, appId)
                relative.startsWith("$USER_PREFIX/") -> File(userRoot(activity, appId), relative.removePrefix("$USER_PREFIX/"))
                relative == TEMP_PREFIX -> tempRoot(activity)
                relative.startsWith("$TEMP_PREFIX/") -> File(tempRoot(activity), relative.removePrefix("$TEMP_PREFIX/"))
                else -> File(tempRoot(activity), relative)
            }
        } else {
            File(path)
        }

        val canonical = file.canonicalFile
        val allowedRoots = listOf(userRoot(activity, appId).canonicalFile, tempRoot(activity).canonicalFile)
        if (allowedRoots.none { canonical.path == it.path || canonical.path.startsWith(it.path + File.separator) }) {
            throw SecurityException("permission denied, open $rawPath")
        }
        return canonical
    }

    private fun toUserPath(activity: DiminaActivity, appId: String, file: File): String {
        val rootPath = userRoot(activity, appId).canonicalPath
        val path = file.canonicalPath
        val relative = path.removePrefix(rootPath).trimStart(File.separatorChar)
        return "$VIRTUAL_PREFIX$USER_PREFIX/$relative"
    }

    private fun pathParam(params: JSONObject): String =
        params.optString("path")
            .ifBlank { params.optString("filePath") }
            .ifBlank { params.optString("dirPath") }
            .ifBlank { params.optString("args") }

    private fun stringParam(params: JSONObject, preferredKey: String): String =
        params.optString(preferredKey)
            .ifBlank { params.optString("path") }
            .ifBlank { params.optString("filePath") }
            .ifBlank { params.optString("dirPath") }
            .ifBlank { params.optString("args") }

    private fun dataBytes(params: JSONObject, key: String = "data", encoding: String? = null): ByteArray {
        val value = params.opt(key)
        if (value is JSONObject && value.optString(FILE_DATA_TYPE_KEY) == "base64") {
            return Base64.decode(value.optString(FILE_DATA_BASE64_KEY), Base64.DEFAULT)
        }
        val text = value?.toString() ?: ""
        return when ((encoding ?: params.optString("encoding", "utf8")).lowercase()) {
            "base64" -> Base64.decode(text, Base64.DEFAULT)
            "hex" -> text.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
            else -> text.toByteArray(Charsets.UTF_8)
        }
    }

    private fun bufferPayload(bytes: ByteArray): JSONObject =
        JSONObject().put(ARRAY_BUFFER_BASE64_KEY, Base64.encodeToString(bytes, Base64.NO_WRAP))

    private fun readBytes(file: File, position: Int = 0, length: Int? = null): ByteArray {
        if (!file.exists()) throw IllegalArgumentException("no such file or directory, open ${file.path}")
        if (file.isDirectory) throw IllegalArgumentException("illegal operation on a directory, open ${file.path}")
        val all = file.readBytes()
        val start = position.coerceAtLeast(0).coerceAtMost(all.size)
        val end = if (length == null || length < 0) all.size else (start + length).coerceAtMost(all.size)
        return all.copyOfRange(start, end)
    }

    private fun accessSync(activity: DiminaActivity, appId: String, path: String) {
        if (!resolve(activity, appId, path).exists()) {
            throw IllegalArgumentException("no such file or directory $path")
        }
    }

    private fun appendFileSync(activity: DiminaActivity, appId: String, params: JSONObject) {
        val file = resolve(activity, appId, params.optString("filePath"))
        if (!file.exists()) throw IllegalArgumentException("no such file or directory, open ${params.optString("filePath")}")
        if (file.isDirectory) throw IllegalArgumentException("illegal operation on a directory, open ${params.optString("filePath")}")
        FileOutputStream(file, true).use { it.write(dataBytes(params)) }
    }

    private fun copyFileSync(activity: DiminaActivity, appId: String, params: JSONObject) {
        val src = resolve(activity, appId, params.optString("srcPath"))
        val dest = resolve(activity, appId, params.optString("destPath"))
        if (!src.exists() || src.isDirectory || dest.parentFile?.exists() != true) {
            throw IllegalArgumentException("no such file or directory, copyFile ${params.optString("srcPath")} -> ${params.optString("destPath")}")
        }
        src.copyTo(dest, overwrite = true)
    }

    private fun mkdirSync(activity: DiminaActivity, appId: String, params: JSONObject) {
        val dir = resolve(activity, appId, params.optString("dirPath"))
        val ok = if (params.optBoolean("recursive", false)) dir.mkdirs() || dir.exists() else dir.mkdir()
        if (!ok) throw IllegalArgumentException("fail mkdir ${params.optString("dirPath")}")
    }

    private fun readdirSync(activity: DiminaActivity, appId: String, path: String): JSONArray {
        val dir = resolve(activity, appId, path)
        if (!dir.isDirectory) throw IllegalArgumentException("not a directory $path")
        return JSONArray().apply { dir.list()?.forEach { put(it) } }
    }

    private fun writeFileSync(activity: DiminaActivity, appId: String, params: JSONObject) {
        val file = resolve(activity, appId, params.optString("filePath"))
        if (file.parentFile?.exists() != true) {
            throw IllegalArgumentException("no such file or directory, open ${params.optString("filePath")}")
        }
        file.writeBytes(dataBytes(params))
    }

    private fun readFileSync(activity: DiminaActivity, appId: String, params: JSONObject): Any {
        val file = resolve(activity, appId, params.optString("filePath"))
        val bytes = readBytes(
            file,
            params.optInt("position", 0),
            if (params.has("length")) params.optInt("length") else null,
        )
        val encoding = params.optString("encoding", "")
        return if (encoding.isBlank()) bufferPayload(bytes) else decodeBytes(bytes, encoding)
    }

    private fun decodeBytes(bytes: ByteArray, encoding: String): String =
        when (encoding.lowercase()) {
            "base64" -> Base64.encodeToString(bytes, Base64.NO_WRAP)
            "hex" -> bytes.joinToString("") { "%02x".format(it) }
            else -> bytes.toString(Charsets.UTF_8)
        }

    private fun unlinkPath(activity: DiminaActivity, appId: String, path: String) {
        val file = resolve(activity, appId, path)
        if (!file.exists() || file.isDirectory || !file.delete()) {
            throw IllegalArgumentException("fail unlink $path")
        }
    }

    private fun rmdirSync(activity: DiminaActivity, appId: String, params: JSONObject) {
        val dir = resolve(activity, appId, params.optString("dirPath"))
        val ok = if (params.optBoolean("recursive", false)) dir.deleteRecursively() else dir.delete()
        if (!ok) throw IllegalArgumentException("fail rmdir ${params.optString("dirPath")}")
    }

    private fun renameSync(activity: DiminaActivity, appId: String, params: JSONObject) {
        val oldFile = resolve(activity, appId, params.optString("oldPath"))
        val newFile = resolve(activity, appId, params.optString("newPath"))
        if (!oldFile.exists() || newFile.parentFile?.exists() != true || !oldFile.renameTo(newFile)) {
            throw IllegalArgumentException("fail rename ${params.optString("oldPath")} -> ${params.optString("newPath")}")
        }
    }

    private fun truncateSync(activity: DiminaActivity, appId: String, params: JSONObject) {
        val file = resolve(activity, appId, params.optString("filePath"))
        RandomAccessFile(file, "rw").use { it.setLength(params.optLong("length", 0L)) }
    }

    private fun saveFileSync(activity: DiminaActivity, appId: String, params: JSONObject): String {
        val temp = resolve(activity, appId, params.optString("tempFilePath"))
        if (!temp.exists() || temp.isDirectory) throw IllegalArgumentException("tempFilePath not found")

        val target = if (params.optString("filePath").isNotBlank()) {
            resolve(activity, appId, params.optString("filePath"))
        } else {
            File(userRoot(activity, appId), "saved/${System.currentTimeMillis()}_${temp.name}")
        }
        target.parentFile?.mkdirs()
        temp.copyTo(target, overwrite = true)
        temp.delete()
        return toUserPath(activity, appId, target)
    }

    private fun getSavedFileList(activity: DiminaActivity, appId: String): JSONObject {
        val list = JSONArray()
        val saved = File(userRoot(activity, appId), "saved")
        if (saved.exists()) {
            saved.walkTopDown().filter { it.isFile }.forEach { file ->
                list.put(JSONObject()
                    .put("filePath", toUserPath(activity, appId, file))
                    .put("size", file.length())
                    .put("createTime", file.lastModified() / 1000))
            }
        }
        return JSONObject().put("fileList", list)
    }

    private fun getFileInfo(activity: DiminaActivity, appId: String, params: JSONObject): JSONObject {
        val file = resolve(activity, appId, params.optString("filePath"))
        if (!file.isFile) throw IllegalArgumentException("file not exist")
        val algorithm = params.optString("digestAlgorithm", "md5").lowercase()
        val digestName = if (algorithm == "sha1") "SHA-1" else "MD5"
        val digest = MessageDigest.getInstance(digestName).digest(file.readBytes())
            .joinToString("") { "%02x".format(it) }
        return JSONObject().put("size", file.length()).put("digest", digest)
    }

    private fun statObject(file: File): JSONObject {
        val isDir = file.isDirectory
        return JSONObject()
            .put("mode", if (isDir) "directory" else "file")
            .put("size", if (isDir) 0 else file.length())
            .put("lastAccessedTime", file.lastModified() / 1000)
            .put("lastModifiedTime", file.lastModified() / 1000)
            .put("isDirectory", isDir)
            .put("isFile", file.isFile)
    }

    private fun statSync(activity: DiminaActivity, appId: String, params: JSONObject): Any {
        val path = params.optString("path").ifBlank { params.optString("args") }
        val file = resolve(activity, appId, path)
        if (!file.exists()) throw IllegalArgumentException("no such file or directory $path")
        if (!params.optBoolean("recursive", false) || !file.isDirectory) {
            return statObject(file)
        }
        return JSONObject().apply {
            file.walkTopDown().forEach { child ->
                val key = child.relativeTo(file).path.ifBlank { "." }
                put(key, statObject(child))
            }
        }
    }

    private fun openSync(activity: DiminaActivity, appId: String, params: JSONObject): String {
        val file = resolve(activity, appId, params.optString("filePath"))
        val flag = params.optString("flag", "r")
        if (flag.contains("w") || flag.contains("a")) {
            file.parentFile?.mkdirs()
        }
        val mode = if (flag == "r") "r" else "rw"
        val raf = RandomAccessFile(file, mode)
        if (flag.startsWith("a")) raf.seek(raf.length())
        if (flag == "w" || flag == "w+") raf.setLength(0)
        val fd = UUID.randomUUID().toString()
        OPEN_FILES[fd] = OpenFile(file, raf)
        return fd
    }

    private fun openedFile(params: JSONObject): OpenFile {
        val fd = params.optString("fd")
        return OPEN_FILES[fd] ?: throw IllegalArgumentException("bad file descriptor")
    }

    private fun closeSync(params: JSONObject) {
        val fd = params.optString("fd").ifBlank { params.optString("args") }
        OPEN_FILES.remove(fd)?.handle?.close() ?: throw IllegalArgumentException("bad file descriptor")
    }

    private fun fstatSync(params: JSONObject): JSONObject = statObject(openedFile(params).file)

    private fun ftruncateSync(params: JSONObject) {
        openedFile(params).handle.setLength(params.optLong("length", 0L))
    }

    private fun readSync(params: JSONObject): JSONObject {
        val file = openedFile(params).handle
        val length = params.optInt("length", params.optInt("arrayBufferLength", 0)).let {
            if (it <= 0) (file.length() - file.filePointer).toInt() else it
        }
        if (params.has("position")) file.seek(params.optLong("position"))
        val bytes = ByteArray(length)
        val count = file.read(bytes).coerceAtLeast(0)
        return JSONObject()
            .put("bytesRead", count)
            .put(ARRAY_BUFFER_BASE64_KEY, Base64.encodeToString(bytes.copyOf(count), Base64.NO_WRAP))
    }

    private fun writeSync(params: JSONObject): JSONObject {
        val file = openedFile(params).handle
        if (params.has("position")) file.seek(params.optLong("position"))
        val offset = params.optInt("offset", 0)
        val allBytes = if (params.has("arrayBuffer")) dataBytes(params, "arrayBuffer") else dataBytes(params)
        val length = if (params.has("length")) params.optInt("length") else allBytes.size - offset
        val bytes = allBytes.copyOfRange(offset, (offset + length).coerceAtMost(allBytes.size))
        file.write(bytes)
        return JSONObject().put("bytesWritten", bytes.size)
    }

    private fun unzip(activity: DiminaActivity, appId: String, params: JSONObject) {
        val zipFile = resolve(activity, appId, params.optString("zipFilePath"))
        val target = resolve(activity, appId, params.optString("targetPath"))
        target.mkdirs()
        ZipFile(zipFile).use { zip ->
            val entries = zip.entries()
            while (entries.hasMoreElements()) {
                val entry = entries.nextElement()
                val out = File(target, entry.name).canonicalFile
                if (!out.path.startsWith(target.canonicalPath + File.separator) && out.path != target.canonicalPath) {
                    throw SecurityException("invalid zip entry ${entry.name}")
                }
                if (entry.isDirectory) {
                    out.mkdirs()
                } else {
                    out.parentFile?.mkdirs()
                    zip.getInputStream(entry).use { input -> FileOutputStream(out).use { input.copyTo(it) } }
                }
            }
        }
    }

    private fun readZipEntry(activity: DiminaActivity, appId: String, params: JSONObject): JSONObject {
        val zipFile = resolve(activity, appId, params.optString("filePath"))
        val result = JSONObject()
        ZipFile(zipFile).use { zip ->
            val requests = zipEntryRequests(params, zip)
            requests.forEach { request ->
                val item = JSONObject()
                val entry = zip.getEntry(request.path)
                if (entry != null && !entry.isDirectory) {
                    val bytes = zip.getInputStream(entry).use { it.readBytes() }
                    val data = sliceBytes(bytes, request.position, request.length)
                    item.put("data", if (request.encoding.isBlank()) bufferPayload(data) else decodeBytes(data, request.encoding))
                    item.put("errMsg", "${PREFIX}readZipEntry:ok")
                } else {
                    item.put("errMsg", "${PREFIX}readZipEntry:fail no such entry ${request.path}")
                }
                result.put(request.path, item)
            }
        }
        return JSONObject().put("entries", result)
    }

    private data class ZipEntryRequest(
        val path: String,
        val encoding: String,
        val position: Int,
        val length: Int?,
    )

    private fun zipEntryRequests(params: JSONObject, zip: ZipFile): List<ZipEntryRequest> {
        val entries = params.opt("entries")
        if (entries is JSONArray) {
            return (0 until entries.length()).map { index ->
                val item = entries.get(index)
                if (item is JSONObject) {
                    ZipEntryRequest(
                        path = item.optString("path"),
                        encoding = item.optString("encoding", ""),
                        position = item.optInt("position", 0),
                        length = if (item.has("length")) item.optInt("length") else null,
                    )
                } else {
                    ZipEntryRequest(item.toString(), "", 0, null)
                }
            }.filter { it.path.isNotBlank() }
        }

        val encoding = params.optString("encoding", "")
        return zip.entries().asSequence()
            .filter { !it.isDirectory }
            .map { ZipEntryRequest(it.name, encoding, 0, null) }
            .toList()
    }

    private fun sliceBytes(bytes: ByteArray, position: Int, length: Int?): ByteArray {
        val start = position.coerceAtLeast(0).coerceAtMost(bytes.size)
        val end = if (length == null || length < 0) {
            bytes.size
        } else {
            (start + length).coerceAtMost(bytes.size)
        }
        return bytes.copyOfRange(start, end)
    }

    private fun readCompressedFileSync(activity: DiminaActivity, appId: String, params: JSONObject): JSONObject {
        val algorithm = params.optString("compressionAlgorithm", "").lowercase()
        if (algorithm != "br") {
            throw IllegalArgumentException("unsupported compressionAlgorithm $algorithm")
        }

        val file = resolve(activity, appId, params.optString("filePath"))
        return try {
            BrotliInputStream(ByteArrayInputStream(readBytes(file))).use { input ->
                val output = ByteArrayOutputStream()
                input.copyTo(output)
                bufferPayload(output.toByteArray())
            }
        } catch (error: Exception) {
            throw IllegalArgumentException("brotli decompress fail", error)
        }
    }
}
