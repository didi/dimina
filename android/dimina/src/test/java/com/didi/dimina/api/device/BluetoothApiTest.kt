package com.didi.dimina.api.device

import com.didi.dimina.api.ApiRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.UUID

class BluetoothApiTest {
    @Test
    fun registersAllBluetoothApis() {
        val registry = ApiRegistry()

        BluetoothApi().registerWith(registry)

        val names = registry.getRegisteredApiNames()
        BluetoothApi.SUPPORTED_API_NAMES.forEach { name ->
            assertTrue("missing $name", names.contains(name))
        }
        assertEquals(29, BluetoothApi.SUPPORTED_API_NAMES.size)
    }

    @Test
    fun expandsBluetoothShortUuids() {
        assertEquals(
            UUID.fromString("0000180d-0000-1000-8000-00805f9b34fb"),
            BluetoothApi.canonicalUuid("180D"),
        )
        assertEquals(
            UUID.fromString("12345678-0000-1000-8000-00805f9b34fb"),
            BluetoothApi.canonicalUuid("12345678"),
        )
    }
}
