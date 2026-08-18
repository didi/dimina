package com.didi.dimina.common

import java.io.File
import java.io.IOException
import java.io.InputStream
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.util.UUID
import java.util.zip.ZipInputStream

/**
 * Extracts an archive away from the active directory and swaps it in only after
 * extraction and validation have completed successfully.
 */
internal object AtomicZipInstaller {
    fun install(
        inputProvider: () -> InputStream,
        targetDir: File,
        requiredPaths: List<String> = emptyList(),
        afterExtract: (File) -> Unit = {},
    ): Boolean {
        val parentDir = targetDir.parentFile ?: return false
        parentDir.mkdirs()
        val stagingDir = File(
            parentDir,
            ".${targetDir.name}.staging-${UUID.randomUUID()}",
        )

        return try {
            inputProvider().use { input ->
                unzip(input, stagingDir)
            }
            afterExtract(stagingDir)
            validateRequiredFiles(stagingDir, requiredPaths)
            replaceDirectory(stagingDir, targetDir)
            true
        } catch (_: Exception) {
            false
        } finally {
            stagingDir.deleteRecursively()
        }
    }

    /**
     * Moves [sourceDir] into [targetDir], restoring the old target if the swap
     * or the optional commit callback fails.
     */
    @Throws(Exception::class)
    fun replaceDirectory(
        sourceDir: File,
        targetDir: File,
        onInstalled: () -> Unit = {},
    ) {
        if (!sourceDir.isDirectory) {
            throw IOException("source directory does not exist: ${sourceDir.path}")
        }

        val parentDir = targetDir.parentFile
            ?: throw IOException("target directory has no parent: ${targetDir.path}")
        parentDir.mkdirs()
        val backupDir = File(
            parentDir,
            ".${targetDir.name}.backup-${UUID.randomUUID()}",
        )
        var oldTargetMoved = false
        var sourceMoved = false

        try {
            if (targetDir.exists()) {
                move(targetDir, backupDir)
                oldTargetMoved = true
            }
            move(sourceDir, targetDir)
            sourceMoved = true
            onInstalled()
            backupDir.deleteRecursively()
        } catch (installError: Exception) {
            try {
                if (sourceMoved && targetDir.exists()) {
                    move(targetDir, sourceDir)
                }
                if (oldTargetMoved && backupDir.exists()) {
                    move(backupDir, targetDir)
                }
            } catch (rollbackError: Exception) {
                installError.addSuppressed(rollbackError)
            }
            throw installError
        }
    }

    private fun unzip(input: InputStream, targetDir: File) {
        targetDir.mkdirs()
        val targetCanonical = targetDir.canonicalFile

        ZipInputStream(input).use { zipInputStream ->
            var entry = zipInputStream.nextEntry
            val buffer = ByteArray(DEFAULT_BUFFER_SIZE)

            while (entry != null) {
                val outputFile = File(targetDir, entry.name).canonicalFile
                if (!outputFile.path.startsWith(targetCanonical.path + File.separator)) {
                    throw IOException("invalid zip entry path: ${entry.name}")
                }

                if (entry.isDirectory) {
                    if (!outputFile.mkdirs() && !outputFile.isDirectory) {
                        throw IOException("failed to create directory: ${entry.name}")
                    }
                } else {
                    val parent = outputFile.parentFile
                    if (parent != null && !parent.mkdirs() && !parent.isDirectory) {
                        throw IOException("failed to create directory: ${parent.path}")
                    }
                    outputFile.outputStream().use { output ->
                        var length: Int
                        while (zipInputStream.read(buffer).also { length = it } > 0) {
                            output.write(buffer, 0, length)
                        }
                    }
                }

                zipInputStream.closeEntry()
                entry = zipInputStream.nextEntry
            }
        }
    }

    private fun validateRequiredFiles(targetDir: File, requiredPaths: List<String>) {
        val targetCanonical = targetDir.canonicalFile
        requiredPaths.forEach { relativePath ->
            val requiredFile = File(targetDir, relativePath).canonicalFile
            if (
                !requiredFile.path.startsWith(targetCanonical.path + File.separator) ||
                !requiredFile.isFile
            ) {
                throw IOException("archive missing required file: $relativePath")
            }
        }
    }

    private fun move(source: File, target: File) {
        try {
            Files.move(
                source.toPath(),
                target.toPath(),
                StandardCopyOption.ATOMIC_MOVE,
                StandardCopyOption.REPLACE_EXISTING,
            )
        } catch (_: AtomicMoveNotSupportedException) {
            Files.move(
                source.toPath(),
                target.toPath(),
                StandardCopyOption.REPLACE_EXISTING,
            )
        }
    }
}
