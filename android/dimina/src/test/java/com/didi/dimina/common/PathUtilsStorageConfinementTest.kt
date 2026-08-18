package com.didi.dimina.common

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Test
import java.nio.file.Files
import java.util.concurrent.Callable
import java.util.concurrent.Executors

class PathUtilsStorageConfinementTest {
    @Test
    fun createsTheSameConfinedRootUnderConcurrentFirstUse() {
        val root = Files.createTempDirectory("dimina-storage-race-test").toFile()
        val platformRoot = root.resolve("cache").apply { mkdirs() }
        val executor = Executors.newFixedThreadPool(8)

        try {
            val results = executor.invokeAll(List(32) {
                Callable { PathUtils.confinedStorageRoot(platformRoot, "safe-app", "tmp") }
            }).map { it.get().canonicalPath }.toSet()
            assertEquals(setOf(platformRoot.resolve("dimina-file-system/safe-app/tmp").canonicalPath), results)
        } finally {
            executor.shutdownNow()
            root.deleteRecursively()
        }
    }

    @Test
    fun rejectsSymlinkedApplicationStorageBeforeCreatingLeafOutsideSandbox() {
        val root = Files.createTempDirectory("dimina-storage-test").toFile()
        val platformRoot = root.resolve("cache").apply { mkdirs() }
        val outside = root.resolve("outside").apply { mkdirs() }
        val storageRoot = platformRoot.resolve("dimina-file-system").apply { mkdirs() }
        Files.createSymbolicLink(storageRoot.resolve("safe-app").toPath(), outside.toPath())

        try {
            assertThrows(IllegalArgumentException::class.java) {
                PathUtils.confinedStorageRoot(platformRoot, "safe-app", "tmp")
            }
            assertFalse(outside.resolve("tmp").exists())
        } finally {
            root.deleteRecursively()
        }
    }
}
