package com.didi.dimina.bean

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * `app.json`'s `networkTimeout` block and each of its four entries are independently optional: a
 * mini program may configure only the timeouts it cares about and expects every entry it left out
 * to keep the documented 60000 ms default.
 *
 * This matters far beyond one API's timeout value. `app-config.json` is decoded once, up front,
 * when the mini program is opened; an entry that fails to decode aborts the whole config parse, so
 * a partially-configured `networkTimeout` would stop the mini program from starting at all instead
 * of degrading a single timeout.
 *
 * Decoding here mirrors the production reader in `DiminaActivity.readAppConfig`, which uses
 * `Json { ignoreUnknownKeys = true }`.
 */
class AppConfigNetworkTimeoutTest {

    private val json = Json { ignoreUnknownKeys = true }

    /** The documented default for every `networkTimeout` entry the mini program leaves unset. */
    private val defaultTimeoutMs = 60000

    /** A minimal decodable `app-config.json`; [appExtras] is appended inside the `app` object. */
    private fun decode(appExtras: String = ""): AppConfig =
        json.decodeFromString<AppConfig>(
            """{"app":{"pages":["pages/index/index"]$appExtras},"modules":{}}""",
        )

    private fun networkTimeoutOf(appExtras: String): NetworkTimeout {
        val parsed = decode(appExtras).app.networkTimeout
        assertNotNull("networkTimeout must have been parsed", parsed)
        return parsed!!
    }

    @Test
    fun networkTimeoutWithOnlyConnectSocketKeepsTheOtherThreeAtTheDefault() {
        val timeout = networkTimeoutOf(""","networkTimeout":{"connectSocket":8000}""")

        assertEquals(8000, timeout.connectSocket)
        assertEquals(defaultTimeoutMs, timeout.request)
        assertEquals(defaultTimeoutMs, timeout.uploadFile)
        assertEquals(defaultTimeoutMs, timeout.downloadFile)
    }

    @Test
    fun networkTimeoutWithOnlyRequestStillYieldsTheDefaultConnectSocketTimeout() {
        val timeout = networkTimeoutOf(""","networkTimeout":{"request":5000}""")

        assertEquals(5000, timeout.request)
        assertEquals(defaultTimeoutMs, timeout.connectSocket)
        assertEquals(defaultTimeoutMs, timeout.uploadFile)
        assertEquals(defaultTimeoutMs, timeout.downloadFile)
    }

    @Test
    fun networkTimeoutWithTwoOfTheFourEntriesDefaultsOnlyTheMissingOnes() {
        val timeout = networkTimeoutOf(""","networkTimeout":{"connectSocket":8000,"downloadFile":45000}""")

        assertEquals(8000, timeout.connectSocket)
        assertEquals(45000, timeout.downloadFile)
        assertEquals(defaultTimeoutMs, timeout.request)
        assertEquals(defaultTimeoutMs, timeout.uploadFile)
    }

    @Test
    fun anEmptyNetworkTimeoutObjectYieldsAllFourDefaults() {
        val timeout = networkTimeoutOf(""","networkTimeout":{}""")

        assertEquals(defaultTimeoutMs, timeout.request)
        assertEquals(defaultTimeoutMs, timeout.connectSocket)
        assertEquals(defaultTimeoutMs, timeout.uploadFile)
        assertEquals(defaultTimeoutMs, timeout.downloadFile)
    }

    @Test
    fun anAppJsonWithoutNetworkTimeoutAtAllParsesWithANullNetworkTimeout() {
        assertNull(decode().app.networkTimeout)
    }

    @Test
    fun networkTimeoutWithAllFourEntriesKeepsEveryConfiguredValue() {
        val timeout = networkTimeoutOf(
            ""","networkTimeout":{"request":1000,"connectSocket":2000,"uploadFile":3000,"downloadFile":4000}""",
        )

        assertEquals(1000, timeout.request)
        assertEquals(2000, timeout.connectSocket)
        assertEquals(3000, timeout.uploadFile)
        assertEquals(4000, timeout.downloadFile)
    }

    @Test
    fun miniGameRuntimeTypeAndEntryAreDecodedWithoutPageModules() {
        val config = json.decodeFromString<AppConfig>(
            """{"app":{"runtimeType":"game","entryPagePath":"game","pages":["game"]},"modules":{}}""",
        )

        assertEquals("game", config.app.runtimeType)
        assertEquals("game", config.app.entryPagePath)
        assertEquals(emptyMap<String, PageModule>(), config.modules)
    }

    @Test
    fun missingRuntimeTypeKeepsMiniProgramCompatibility() {
        assertEquals("miniProgram", decode().app.runtimeType)
    }
}
