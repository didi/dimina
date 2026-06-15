package com.didi.dimina.api.file

import com.didi.dimina.api.ApiRegistry
import org.junit.Assert.assertTrue
import org.junit.Test

class FileApiTest {
    @Test
    fun registersAllFileApis() {
        val registry = ApiRegistry()

        FileApi().registerWith(registry)

        val names = registry.getRegisteredApiNames()
        listOf(
            "saveFileToDisk",
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
        ).forEach { name ->
            assertTrue("missing $name", names.contains(name))
        }
    }
}
