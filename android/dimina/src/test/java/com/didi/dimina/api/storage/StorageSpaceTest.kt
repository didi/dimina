package com.didi.dimina.api.storage

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread

class StorageSpaceTest {
    private fun wire(data: String, type: String = "String") =
        JSONObject().put("data", data).put("dataType", type).put("entrySize", 0)

    private class Fixture {
        val records = linkedMapOf<String, StorageRecord>()
        var commits = 0
        val space = StorageSpace(Any(), { records.toMap() }) { key, encoded ->
            commits++
            records[key] = StorageRecordCodec.decode(encoded)!!
            true
        }
    }

    @Test
    fun quoteLengthMatchesJsonStringifyUtf16IncludingSlashAndLoneSurrogates() {
        assertEquals(6L, StorageWire.quotedLength("</x>"))
        assertEquals(4L, StorageWire.quotedLength("\uD83D\uDE00"))
        assertEquals(8L, StorageWire.quotedLength("\uD800"))
        assertEquals(8L, StorageWire.quotedLength("\u0000"))
        assertEquals(6L, StorageWire.quotedLength("\n\t"))
    }

    @Test
    fun recomputesForgedSizeAndCountsOnlyTheWechatTypedRecord() {
        val f = Fixture()
        f.space.set("x", "é", wire("é"))
        val record = f.records.getValue("x")
        assertEquals(36L, record.wire!!.getLong("entrySize"))
        assertEquals(1L, f.space.info().getLong("currentSize"))
        assertEquals(10240L, f.space.info().getLong("limitSize"))
        assertEquals(1L, Fixture().space.info().getLong("currentSize"))
        val wrapped = f.space.get("x", true) as JSONObject
        assertEquals(1, wrapped.getInt("__diminaStorageResult"))
        assertEquals("é", wrapped.getJSONObject("record").getString("data"))
        assertEquals("é", f.space.get("x", false))
    }

    @Test
    fun quotaBoundaryAndRejectedOverwritePreserveTheOriginalRecord() {
        val f = Fixture()
        val exact = "x".repeat(10 * 1024 * 1024 - 43)
        assertTrue(f.space.set("x", exact, wire(exact)))
        assertEquals(10240L, f.space.info().getLong("currentSize"))
        val error = runCatching { f.space.set("x", exact + "!", wire(exact + "!")) }.exceptionOrNull()
        assertEquals(StorageWire.QUOTA_ERROR, error?.message)
        assertEquals(1, f.commits)
        assertEquals(exact, f.space.get("x", false))
        assertTrue(f.space.set("x", "small", wire("small")))
        assertEquals(1L, f.space.info().getLong("currentSize"))
    }

    @Test
    fun legacyAndDeletedRecordsKeepReadCompatibilityWithoutChargingDatabaseMetadata() {
        val f = Fixture()
        f.records["legacy"] = StorageRecord(false, 12)
        f.records["deleted"] = StorageRecord(true)
        val wrapped = f.space.get("legacy", true) as JSONObject
        assertEquals(12, wrapped.getInt("value"))
        assertFalse(wrapped.has("record"))
        assertNull(f.space.get("deleted", true))
        assertEquals(listOf("legacy"), f.space.info().getJSONArray("keys").let { values ->
            (0 until values.length()).map(values::getString)
        })
    }

    @Test
    fun simultaneousWritesCannotBothPassTheQuotaCheck() {
        val f = Fixture()
        val ready = CountDownLatch(2)
        val start = CountDownLatch(1)
        val accepted = AtomicInteger()
        val payload = "x".repeat(5 * 1024 * 1024)
        val workers = (1..2).map { index -> thread {
            ready.countDown()
            start.await()
            runCatching { if (f.space.set("$index", payload, wire(payload))) accepted.incrementAndGet() }
        } }
        ready.await()
        start.countDown()
        workers.forEach { it.join() }
        assertEquals(1, accepted.get())
        assertEquals(1, f.commits)
        assertEquals(1, f.records.size)
    }
}
