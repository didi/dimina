package com.didi.dimina.common

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class JavaScriptUtilsTest {
    @Test
    fun quotesMessagesBeforeEmbeddingThemInJavaScript() {
        val message = JSONObject()
            .put("value", "\");globalThis.compromised=true;//\nnext")
            .toString()

        assertEquals(
            "DiminaRenderBridge.onMessage(JSON.parse(${JSONObject.quote(message)}))",
            JavaScriptUtils.invokeWithJson("DiminaRenderBridge.onMessage", message),
        )
    }

    @Test
    fun rejectsExecutableFunctionNames() {
        assertThrows(IllegalArgumentException::class.java) {
            JavaScriptUtils.invokeWithJson("handler);alert(1);//", "{}")
        }
    }
}
