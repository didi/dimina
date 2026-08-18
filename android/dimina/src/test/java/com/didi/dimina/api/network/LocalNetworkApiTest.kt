package com.didi.dimina.api.network

import com.didi.dimina.api.ApiRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class LocalNetworkApiTest {
    @Test
    fun registersAllNativeLocalNetworkMethods() {
        val registry = ApiRegistry()
        LocalNetworkApi().registerWith(registry)

        val names = registry.getRegisteredApiNames()
        LocalNetworkApi.SUPPORTED_API_NAMES.forEach { name ->
            assertTrue("Expected $name to be registered", names.contains(name))
        }
        assertEquals(38, LocalNetworkApi.SUPPORTED_API_NAMES.size)
    }
}
