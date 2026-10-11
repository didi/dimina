package com.didi.dimina.api.file

import android.content.Context
import android.content.ContextWrapper
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.didi.dimina.api.AsyncResult
import com.didi.dimina.api.SyncResult
import com.didi.dimina.common.PathUtils
import com.didi.dimina.ui.container.DiminaActivity
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class FileSystemCacheTest {
    @Test
    fun binaryFileApisPreserveLargePayloadAndDescriptorRanges() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        lateinit var activity: DiminaActivity
        instrumentation.runOnMainSync {
            activity = DiminaActivity()
            ContextWrapper::class.java.getDeclaredMethod("attachBaseContext", Context::class.java)
                .apply { isAccessible = true }.invoke(activity, instrumentation.targetContext)
        }
        val appId = "binary-file-test-${UUID.randomUUID()}"
        val api = FileApi()
        fun args(vararg pairs: Pair<String, Any>) = JSONObject().apply { pairs.forEach { put(it.first, it.second) } }
        fun sync(name: String, params: JSONObject) =
            (api.handleAction(activity, appId, "FileSystemManager.$name", params) {} as SyncResult).value
        val path = "${PathUtils.VIRTUAL_DOMAIN_URL}usr/asset.bin"
        val bytes = ByteArray(8 * 1024 * 1024) { 173.toByte() }.apply { this[0] = 0; this[lastIndex] = 255.toByte() }
        try {
            sync("writeFileSync", args("filePath" to path, "data" to bytes))
            assertArrayEquals(bytes, sync("readFileSync", args("filePath" to path)).objectValue as ByteArray)
            val async = api.handleAction(activity, appId, "FileSystemManager.readFile", args("filePath" to path)) {} as AsyncResult
            assertArrayEquals(bytes, async.value.get("data") as ByteArray)
            val fd = sync("openSync", args("filePath" to path, "flag" to "r+")).stringValue!!
            try {
                val part = sync("readSync", args("fd" to fd, "position" to bytes.size - 2, "length" to 10)).objectValue as JSONObject
                assertEquals(2, part.getInt("bytesRead"))
                assertArrayEquals(byteArrayOf(173.toByte(), 255.toByte()), part.get("arrayBuffer") as ByteArray)
                val eof = sync("readSync", args("fd" to fd, "position" to bytes.size, "length" to 1)).objectValue as JSONObject
                assertEquals(0, eof.getInt("bytesRead"))
                assertArrayEquals(ByteArray(0), eof.get("arrayBuffer") as ByteArray)
                sync("writeSync", args("fd" to fd, "position" to 1, "arrayBuffer" to byteArrayOf(9, 7, 8, 9), "offset" to 1, "length" to 2))
            } finally { sync("closeSync", args("fd" to fd)) }
            assertArrayEquals(byteArrayOf(0, 7, 8, 173.toByte()),
                sync("readFileSync", args("filePath" to path, "position" to 0, "length" to 4)).objectValue as ByteArray)
        } finally {
            PathUtils.appUserRoot(activity, appId).deleteRecursively()
            PathUtils.appTempRoot(activity, appId).deleteRecursively()
        }
    }

    @Test
    fun readsPackagedWasmAndBrotliWithoutAllowingWritesOrTraversal() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        lateinit var activity: DiminaActivity
        instrumentation.runOnMainSync {
            activity = DiminaActivity()
            ContextWrapper::class.java.getDeclaredMethod("attachBaseContext", Context::class.java)
                .apply { isAccessible = true }.invoke(activity, instrumentation.targetContext)
        }
        val appId = "wasm-package-test-${UUID.randomUUID()}"
        val root = java.io.File(activity.filesDir, "jsapp/$appId")
        val directory = java.io.File(root, "main/utils").apply { mkdirs() }
        val wasm = byteArrayOf(0, 97, 115, 109, 1, 0, 0, 0)
        java.io.File(directory, "module.wasm").writeBytes(wasm)
        java.io.File(directory, "module.wasm.br").writeBytes(byteArrayOf(139.toByte(), 3, 128.toByte(), 0, 97, 115, 109, 1, 0, 0, 0, 3))
        val api = FileApi()
        fun call(name: String, path: String, ok: Boolean = true): JSONObject {
            val params = JSONObject().put("filePath", path).put("compressionAlgorithm", "br")
            val result = api.handleAction(activity, appId, "FileSystemManager.$name", params) {} as AsyncResult
            assertEquals(result.value.toString(), ok, result.value.getString("errMsg").endsWith(":ok"))
            return result.value
        }
        try {
            for (path in listOf("utils/module.wasm", "/utils/module.wasm")) {
                assertArrayEquals(wasm, call("readFile", path).get("data") as ByteArray)
            }
            assertArrayEquals(wasm, call("readCompressedFile", "/utils/module.wasm.br").get("data") as ByteArray)
            call("readFile", "../../outside.wasm", false)
            call("writeFile", "/utils/module.wasm", false)
            assertArrayEquals(wasm, java.io.File(directory, "module.wasm").readBytes())
        } finally {
            root.deleteRecursively()
            PathUtils.appUserRoot(activity, appId).deleteRecursively()
            PathUtils.appTempRoot(activity, appId).deleteRecursively()
        }
    }

    @Test
    fun persistsTwoMegabyteCacheAndRejectsInvalidCleanup() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        lateinit var activity: DiminaActivity
        // File APIs only need an app Context, not a launched mini-program or WebView.
        instrumentation.runOnMainSync {
            activity = DiminaActivity()
            ContextWrapper::class.java.getDeclaredMethod("attachBaseContext", Context::class.java)
                .apply { isAccessible = true }.invoke(activity, instrumentation.targetContext)
        }
        val appId = "file-cache-test-${UUID.randomUUID()}"
        val api = FileApi()
        fun call(name: String, params: JSONObject, ok: Boolean = true): JSONObject {
            val result = api.handleAction(activity, appId, "FileSystemManager.$name", params) {} as AsyncResult
            assertEquals(result.value.toString(), ok, result.value.getString("errMsg").endsWith(":ok"))
            return result.value
        }
        fun args(vararg pairs: Pair<String, Any>) = JSONObject().apply { pairs.forEach { put(it.first, it.second) } }
        val base = "${PathUtils.VIRTUAL_DOMAIN_URL}usr/form-cache"
        val file = "$base/form.json"
        try {
            call("access", args("path" to base), false)
            call("mkdir", args("dirPath" to base, "recursive" to true))
            val json = "{\"form\":\"" + "x".repeat(2 * 1024 * 1024) + "中文\"}"
            call("writeFile", args("filePath" to file, "data" to json, "encoding" to "utf8"))
            assertEquals(json, call("readFile", args("filePath" to file, "encoding" to "utf8")).getString("data"))
            call("writeFile", args("filePath" to file, "data" to "{}", "encoding" to "utf8"))
            assertEquals("{}", call("readFile", args("filePath" to file, "encoding" to "utf8")).getString("data"))
            call("mkdir", args("dirPath" to file, "recursive" to true), false)
            call("mkdir", args("dirPath" to base, "recursive" to true), false)
            call("copyFile", args("srcPath" to file, "destPath" to file))
            call("copyFile", args("srcPath" to "$base/missing", "destPath" to file), false)
            assertEquals("{}", call("readFile", args("filePath" to file, "encoding" to "utf8")).getString("data"))
            call("copyFile", args("srcPath" to file, "destPath" to base), false)
            for (root in listOf("${PathUtils.VIRTUAL_DOMAIN_URL}usr", "${PathUtils.VIRTUAL_DOMAIN_URL}tmp")) {
                call("rmdir", args("dirPath" to root, "recursive" to true), false)
                call("rename", args("oldPath" to root, "newPath" to "$base/moved"), false)
                call("rename", args("oldPath" to base, "newPath" to root), false)
            }
            assertEquals(2, call("stat", args("path" to file, "recursive" to true)).getJSONObject("stats").getInt("size"))
            val stats = call("stat", args("path" to base, "recursive" to true)).getJSONObject("stats")
            assertTrue(stats.getJSONObject("").getBoolean("isDirectory"))
            assertEquals(32768, stats.getJSONObject("/form.json").getInt("mode") and 61440)
            call("writeFile", args("filePath" to "$base/replacement", "data" to "{}", "encoding" to "utf8"))
            call("rename", args("oldPath" to "$base/replacement", "newPath" to file))
            call("copyFile", args("srcPath" to file, "destPath" to "$base/copy.json"))
            call("rename", args("oldPath" to "$base/copy.json", "newPath" to "$base/renamed.json"))
            assertEquals(2, call("readdir", args("dirPath" to base)).getJSONArray("files").length())
            assertTrue(call("stat", args("path" to base, "recursive" to true)).getJSONObject("stats").has("/form.json"))
            call("rmdir", args("dirPath" to base), false)
            call("rmdir", args("dirPath" to file, "recursive" to true), false)
            call("unlink", args("filePath" to base), false)
            call("access", args("path" to file))
            call("unlink", args("filePath" to "$base/renamed.json"))
            call("rmdir", args("dirPath" to base, "recursive" to true))
            call("access", args("path" to file), false)
        } finally {
            PathUtils.appUserRoot(activity, appId).deleteRecursively()
            PathUtils.appTempRoot(activity, appId).deleteRecursively()
        }
    }
}
