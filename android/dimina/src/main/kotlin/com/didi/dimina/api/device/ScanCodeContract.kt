package com.didi.dimina.api.device

import com.google.zxing.BarcodeFormat
import org.json.JSONArray
import org.json.JSONObject
import java.util.Base64

data class ScanCodeOptions(
    val onlyFromCamera: Boolean,
    val scanTypes: List<String>,
) {
    companion object {
        fun from(params: JSONObject): ScanCodeOptions {
            val requestedTypes = if (params.has("scanType")) {
                params.optJSONArray("scanType")?.toStringList().orEmpty()
            } else {
                null
            }
            val scanTypes = when {
                requestedTypes == null -> ScanCodeFormats.defaultScanTypes
                requestedTypes.isEmpty() -> ScanCodeFormats.defaultScanTypes
                else -> requestedTypes.filter { ScanCodeFormats.supports(it) }.distinct()
            }

            return ScanCodeOptions(
                onlyFromCamera = params.optBoolean("onlyFromCamera", false),
                scanTypes = scanTypes,
            )
        }
    }
}

object ScanCodeFormats {
    val defaultScanTypes = listOf("barCode", "qrCode")
    val supportedWechatResultScanTypes = setOf(
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
    )

    private val zxingFormatNamesByScanType = mapOf(
        "barCode" to setOf(
            "CODABAR",
            "CODE_39",
            "CODE_93",
            "CODE_128",
            "EAN_8",
            "EAN_13",
            "ITF",
            "RSS_14",
            "RSS_EXPANDED",
            "UPC_A",
            "UPC_E",
            "UPC_EAN_EXTENSION",
        ),
        "qrCode" to setOf("QR_CODE"),
        "datamatrix" to setOf("DATA_MATRIX"),
        "pdf417" to setOf("PDF_417"),
    )

    fun supports(scanType: String): Boolean {
        return zxingFormatNamesByScanType.containsKey(scanType)
    }

    fun zxingFormatNamesFor(scanTypes: List<String>): Set<String> {
        return scanTypes.flatMap { zxingFormatNamesByScanType[it].orEmpty() }.toSet()
    }

    fun zxingFormatsFor(scanTypes: List<String>): Collection<BarcodeFormat> {
        return zxingFormatNamesFor(scanTypes).map { BarcodeFormat.valueOf(it) }
    }
}

data class ScanCodePayload(
    val result: String,
    val scanType: String,
    val charSet: String,
    val rawData: String,
    val path: String,
) {
    companion object {
        fun fromText(
            text: String,
            scanType: String,
            rawBytes: ByteArray?,
            charSet: String = "UTF-8",
        ): ScanCodePayload {
            val bytes = rawBytes?.takeIf { it.isNotEmpty() } ?: text.toByteArray(Charsets.UTF_8)
            return ScanCodePayload(
                result = text,
                scanType = scanType,
                charSet = charSet,
                rawData = Base64.getEncoder().encodeToString(bytes),
                path = if (scanType == "QR_CODE" && text.startsWith("/")) text else "",
            )
        }
    }

    fun toJson(apiName: String): JSONObject {
        return JSONObject().apply {
            put("result", result)
            put("scanType", scanType)
            put("charSet", charSet)
            put("rawData", rawData)
            put("path", path)
            put("errMsg", "$apiName:ok")
        }
    }
}

private fun JSONArray.toStringList(): List<String> {
    return (0 until length()).mapNotNull { index ->
        opt(index) as? String
    }
}
