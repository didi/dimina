package com.didi.dimina.common

/**
 * Decides whether a versioned resource bundled in the host APK must be extracted.
 *
 * The decision is deliberately local to each resource. A host-app update marker is
 * shared state and can be consumed by another resource before this one is prepared.
 */
internal object BundledResourcePolicy {
    fun shouldExtract(
        bundledVersion: Int,
        installedVersion: Int,
        requiredResourcePresent: Boolean,
    ): Boolean {
        return !requiredResourcePresent || bundledVersion > installedVersion
    }
}
