package com.didi.dimina.api.device

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ScanCodeContractTest {
    @Test
    fun usesWechatDefaultScanTypesWhenMissing() {
        val options = ScanCodeOptions.from(JSONObject())

        assertEquals(listOf("barCode", "qrCode"), options.scanTypes)
        assertEquals(
            setOf(
                "CODABAR",
                "CODE_39",
                "CODE_93",
                "CODE_128",
                "EAN_8",
                "EAN_13",
                "ITF",
                "QR_CODE",
                "RSS_14",
                "RSS_EXPANDED",
                "UPC_A",
                "UPC_E",
                "UPC_EAN_EXTENSION",
            ),
            ScanCodeFormats.zxingFormatNamesFor(options.scanTypes),
        )
    }

    @Test
    fun mapsRequestedScanTypesToNativeFormats() {
        val options = ScanCodeOptions.from(JSONObject("""{"scanType":["qrCode","pdf417","datamatrix"]}"""))

        assertEquals(listOf("qrCode", "pdf417", "datamatrix"), options.scanTypes)
        assertEquals(
            setOf("DATA_MATRIX", "PDF_417", "QR_CODE"),
            ScanCodeFormats.zxingFormatNamesFor(options.scanTypes),
        )
    }

    @Test
    fun usesWechatDefaultScanTypesWhenScanTypeArrayIsEmpty() {
        val options = ScanCodeOptions.from(JSONObject("""{"scanType":[]}"""))

        assertEquals(listOf("barCode", "qrCode"), options.scanTypes)
    }

    @Test
    fun excludesWxCodeAndDoesNotFallBackWhenExplicitScanTypesAreUnsupported() {
        val options = ScanCodeOptions.from(JSONObject("""{"scanType":["wxCode","unknown"]}"""))

        assertEquals(emptyList<String>(), options.scanTypes)
        assertEquals(emptySet<String>(), ScanCodeFormats.zxingFormatNamesFor(options.scanTypes))
    }

    @Test
    fun exposesWechatResultScanTypesExceptWxCodeForSupportedNativeFormats() {
        assertEquals(
            setOf(
                "AZTEC",
                "CODABAR",
                "CODE_128",
                "CODE_39",
                "CODE_93",
                "DATA_MATRIX",
                "EAN_13",
                "EAN_8",
                "ITF",
                "MAXICODE",
                "PDF_417",
                "QR_CODE",
                "RSS_14",
                "RSS_EXPANDED",
                "UPC_A",
                "UPC_E",
                "UPC_EAN_EXTENSION",
            ),
            ScanCodeFormats.supportedWechatResultScanTypes,
        )
    }

    @Test
    fun payloadUsesWechatScanCodeResultShape() {
        val payload = ScanCodePayload.fromText(
            text = "https://example.com/a",
            scanType = "QR_CODE",
            rawBytes = byteArrayOf(0x01, 0x02, 0x03),
            charSet = "UTF-8",
        ).toJson("scanCode")

        assertEquals("https://example.com/a", payload.getString("result"))
        assertEquals("QR_CODE", payload.getString("scanType"))
        assertEquals("UTF-8", payload.getString("charSet"))
        assertEquals("AQID", payload.getString("rawData"))
        assertEquals("scanCode:ok", payload.getString("errMsg"))
        assertTrue(payload.has("path"))
    }
}
