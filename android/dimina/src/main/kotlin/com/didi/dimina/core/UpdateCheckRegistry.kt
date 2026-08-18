package com.didi.dimina.core

internal class UpdateCheckRegistry {
    private val startedAppIds = mutableSetOf<String>()

    @Synchronized
    fun begin(appId: String): Boolean = startedAppIds.add(appId)

    @Synchronized
    fun reset(appId: String) {
        startedAppIds.remove(appId)
    }

    @Synchronized
    fun resetAll() {
        startedAppIds.clear()
    }
}
