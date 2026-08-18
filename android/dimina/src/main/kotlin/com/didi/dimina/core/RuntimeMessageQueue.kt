package com.didi.dimina.core

/**
 * Serializes service messages and terminal engine destruction onto one scheduler. Closing the
 * queue rejects late messages while preserving every action accepted before the close barrier.
 */
internal class RuntimeMessageQueue(
    private val enqueue: ((() -> Unit) -> Unit),
) {
    private var acceptingMessages = true

    @Synchronized
    fun post(action: () -> Unit): Boolean {
        if (!acceptingMessages) return false
        enqueue(action)
        return true
    }

    @Synchronized
    fun closeAfterPending(action: () -> Unit): Boolean {
        if (!acceptingMessages) return false
        acceptingMessages = false
        enqueue(action)
        return true
    }

    @Synchronized
    fun closeNow(): Boolean {
        if (!acceptingMessages) return false
        acceptingMessages = false
        return true
    }
}
