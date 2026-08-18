package com.didi.dimina.api.network

import android.webkit.MimeTypeMap
import com.didi.dimina.api.APIResult
import com.didi.dimina.api.AsyncResult
import com.didi.dimina.api.BaseApiHandler
import com.didi.dimina.api.NoneResult
import com.didi.dimina.common.ApiUtils
import com.didi.dimina.common.PathUtils
import com.didi.dimina.ui.container.DiminaActivity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import okhttp3.Call
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okio.Buffer
import okio.BufferedSink
import okio.ForwardingSink
import okio.buffer
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import java.io.File
import java.io.IOException
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

/**
 * Network API implementation
 * Author: Doslin
 *
 * Handles network operations like HTTP requests, file downloads, and uploads
 */
class NetworkApi : BaseApiHandler() {
    companion object {
        private const val REQUEST = "request"
        private const val DOWNLOAD_FILE = "downloadFile"
        private const val UPLOAD = "uploadFile"
        private const val ABORT_UPLOAD = "uploadFileTaskAbort"

        // 单例 OkHttpClient
        private val client: OkHttpClient by lazy {
            OkHttpClient.Builder()
                .connectTimeout(60_000, TimeUnit.MILLISECONDS) // 默认超时时间
                .readTimeout(60_000, TimeUnit.MILLISECONDS)
                .writeTimeout(60_000, TimeUnit.MILLISECONDS)
                .build()
        }

        internal fun parseResponseData(
            bodyString: String,
            dataType: String,
            responseType: String,
        ): Any {
            if (responseType.equals("arraybuffer", ignoreCase = true)) {
                return bodyString
            }

            val shouldParseJson = dataType.equals("json", ignoreCase = true) ||
                    responseType.equals("json", ignoreCase = true)
            if (!shouldParseJson || bodyString.isEmpty()) {
                return bodyString
            }

            return try {
                when (val value = JSONTokener(bodyString).nextValue()) {
                    is JSONObject -> value
                    is JSONArray -> value
                    else -> value
                }
            } catch (_: Exception) {
                bodyString
            }
        }

        internal fun uploadFormData(params: JSONObject): JSONObject? = params.optJSONObject("formData")

        internal fun buildUploadMultipartBody(
            file: File,
            name: String,
            formData: JSONObject?,
            mimeType: String = MimeTypeMap.getSingleton().getMimeTypeFromExtension(file.extension.lowercase())
                ?: "application/octet-stream",
        ): MultipartBody {
            val builder = MultipartBody.Builder().setType(MultipartBody.FORM)
                .addFormDataPart(name, file.name, file.asRequestBody(mimeType.toMediaTypeOrNull()))
            formData?.keys()?.forEach { key ->
                builder.addFormDataPart(key, formData.optString(key))
            }
            return builder.build()
        }

        internal fun uploadProgress(totalBytes: Long, sentBytes: Long): JSONObject = JSONObject().apply {
            val progress = if (totalBytes > 0) ((sentBytes * 100) / totalBytes).coerceIn(0, 100) else 0
            put("progress", progress)
            put("totalBytesSent", sentBytes)
            put("totalBytesExpectedToSend", totalBytes.coerceAtLeast(0))
        }
    }

    private val uploadCalls = ConcurrentHashMap<String, Call>()

    override val apiNames = setOf(REQUEST, DOWNLOAD_FILE, UPLOAD, ABORT_UPLOAD)

    override fun handleAction(
        activity: DiminaActivity,
        appId: String,
        apiName: String,
        params: JSONObject,
        responseCallback: (String) -> Unit,
    ): APIResult {
        return when (apiName) {
            REQUEST -> {
                val url = params.optString("url")

                if (url.isEmpty()) {
                    return AsyncResult(JSONObject().apply {
                        put("errMsg", "$REQUEST:fail url is required")
                    })
                }

                val data = params.optString("data")
                val header = params.optJSONObject("header")
                val timeout = params.optInt("timeout", 60000)
                val method = params.optString("method", "GET")
                val dataType = params.optString("dataType", "json")
                val responseType = params.optString("responseType", "text")

                // Create OkHttp client with timeout
                // 使用单例 client，但根据参数动态调整超时时间
                val adjustedClient = if (timeout != 60000) { // 如果超时时间不是默认值
                    client.newBuilder()
                        .connectTimeout(timeout.toLong(), TimeUnit.MILLISECONDS)
                        .readTimeout(timeout.toLong(), TimeUnit.MILLISECONDS)
                        .writeTimeout(timeout.toLong(), TimeUnit.MILLISECONDS)
                        .build()
                } else {
                    client // 直接使用单例
                }

                // Build request
                val requestBuilder = Request.Builder()
                    .url(url)

                // Set headers
                header?.let {
                    header.keys().forEach { key ->
                        requestBuilder.addHeader(key, header.optString(key))
                    }
                }

                // Set request body based on method
                when (method) {
                    "POST", "PUT" -> {
                        val mediaType = when (dataType.lowercase()) {
                            "json" -> "application/json; charset=utf-8"
                            else -> "text/plain; charset=utf-8"
                        }
                        val body = if (data.isNotEmpty()) {
                            data.toRequestBody(mediaType.toMediaTypeOrNull())
                        } else {
                            "".toRequestBody(mediaType.toMediaTypeOrNull())
                        }
                        requestBuilder.method(method, body)
                    }

                    "GET", "HEAD", "DELETE" -> {
                        requestBuilder.method(method, null)
                    }

                    else -> {
                        return AsyncResult(JSONObject().apply {
                            put("errMsg", "$REQUEST:fail unsupported method $method")
                        })
                    }
                }

                val request = requestBuilder.build()
                try {
                    CoroutineScope(Dispatchers.IO).launch {
                        try {
                            adjustedClient.newCall(request).execute().use { response ->
                                val bodyString = response.body?.string() ?: ""
                                val result = JSONObject().apply {
                                    put("errMsg", "$REQUEST:ok")
                                    put("statusCode", response.code)
                                    put("data", parseResponseData(bodyString, dataType, responseType))
                                    put("header", JSONObject().apply {
                                        response.headers.toMultimap().forEach { (key, values) ->
                                            put(key, values.joinToString(","))
                                        }
                                    })
                                }

                                ApiUtils.invokeSuccess(params, result, responseCallback)
                                ApiUtils.invokeComplete(params, responseCallback)
                            }
                        } catch (e: IOException) {
                            ApiUtils.invokeFail(params, JSONObject().apply {
                                put("errMsg", "$REQUEST:fail network error: ${e.message}")
                            }, responseCallback)
                            ApiUtils.invokeComplete(params, responseCallback)
                        } catch (e: Exception) {
                            ApiUtils.invokeFail(params, JSONObject().apply {
                                put("errMsg", "$REQUEST:fail ${e.message}")
                            }, responseCallback)
                            ApiUtils.invokeComplete(params, responseCallback)
                        }
                    }
                } catch (e: IOException) {
                    AsyncResult(JSONObject().apply {
                        put("errMsg", "$REQUEST:fail network error: ${e.message}")
                    })
                } catch (e: Exception) {
                    AsyncResult(JSONObject().apply {
                        put("errMsg", "$REQUEST:fail ${e.message}")
                    })
                }

                NoneResult()
            }

            DOWNLOAD_FILE -> {
                val url = params.optString("url")

                if (url.isEmpty()) {
                    return AsyncResult(JSONObject().apply {
                        put("errMsg", "$DOWNLOAD_FILE:fail url is required")
                    })
                }

                val header = params.optJSONObject("header")
                val timeout = params.optInt("timeout", 60000)
                val filePath = params.optString("filePath")

                val adjustedClient = if (timeout != 60000) { // 如果超时时间不是默认值
                    client.newBuilder()
                        .connectTimeout(timeout.toLong(), TimeUnit.MILLISECONDS)
                        .readTimeout(timeout.toLong(), TimeUnit.MILLISECONDS)
                        .writeTimeout(timeout.toLong(), TimeUnit.MILLISECONDS)
                        .build()
                } else {
                    client // 直接使用单例
                }

                CoroutineScope(Dispatchers.IO).launch {
                    try {
                        val requestBuilder = Request.Builder()
                            .url(url)

                        // Set headers
                        header?.let {
                            header.keys().forEach { key ->
                                requestBuilder.addHeader(key, header.optString(key))
                            }
                        }
                        val request = requestBuilder.build()
                        val response = adjustedClient.newCall(request).execute()

                        if (!response.isSuccessful) {
                            ApiUtils.invokeFail(params, JSONObject().apply {
                                put("errMsg", "$DOWNLOAD_FILE:fail HTTP ${response.code}")
                            }, responseCallback)
                            ApiUtils.invokeComplete(params, responseCallback)
                            return@launch
                        }

                        val body = response.body
                        if (body == null) {
                            ApiUtils.invokeFail(params, JSONObject().apply {
                                put("errMsg", "$DOWNLOAD_FILE:fail empty response")
                            }, responseCallback)
                            ApiUtils.invokeComplete(params, responseCallback)
                            return@launch
                        }

                        val ext = MimeTypeMap.getSingleton().getExtensionFromMimeType(body.contentType()?.toString()) ?: "tmp"
                        val outFile = if (filePath.isNotEmpty()) {
                            PathUtils.appTempFile(activity, appId, filePath)
                        } else {
                            File.createTempFile(
                                "download_${System.currentTimeMillis()}",
                                ".$ext",
                                PathUtils.appTempRoot(activity, appId),
                            )
                        }

                        outFile.outputStream().use { output ->
                            body.byteStream().use { input ->
                                input.copyTo(output)
                            }
                        }

                        ApiUtils.invokeSuccess(params, JSONObject().apply {
                            put("tempFilePath", PathUtils.pathToVirtual(outFile))
                            put("filePath", filePath)
                            put("statusCode", response.code)
                            put("errMsg", "$DOWNLOAD_FILE:ok")
                        }, responseCallback)

                        ApiUtils.invokeComplete(params, responseCallback)

                    } catch (e: Exception) {
                        ApiUtils.invokeFail(params, JSONObject().apply {
                            put("errMsg", "$DOWNLOAD_FILE:fail ${e.message}")
                        }, responseCallback)

                        ApiUtils.invokeComplete(params, responseCallback)
                    }
                }

                NoneResult()
            }

            UPLOAD -> {
                val url = params.optString("url")
                val header = params.optJSONObject("header")
                val timeout = params.optInt("timeout", 60_000).takeIf { it > 0 } ?: 60_000
                val filePath = params.optString("filePath")
                val name = params.optString("name")
                val formData = uploadFormData(params)
                val taskId = params.optString("taskId").ifEmpty { UUID.randomUUID().toString() }
                val progressCallbackId = params.optString("progressCallback")
                val headersCallbackId = params.optString("headersCallback")

                fun failImmediately(message: String): APIResult {
                    val result = JSONObject().put("errMsg", "$UPLOAD:fail $message")
                    ApiUtils.invokeFail(params, result, responseCallback)
                    ApiUtils.invokeComplete(params, responseCallback, result)
                    return NoneResult()
                }

                if (url.isEmpty() || filePath.isEmpty() || name.isEmpty()) {
                    return failImmediately("missing required parameters")
                }

                val adjustedClient = if (timeout != 60_000) {
                    client.newBuilder()
                        .connectTimeout(timeout.toLong(), TimeUnit.MILLISECONDS)
                        .readTimeout(timeout.toLong(), TimeUnit.MILLISECONDS)
                        .writeTimeout(timeout.toLong(), TimeUnit.MILLISECONDS)
                        .build()
                } else {
                    client
                }

                val call = try {
                    val file = File(PathUtils.pathToReal(activity, filePath, appId))
                    if (!file.isFile) return failImmediately("file does not exist")
                    val multipart = buildUploadMultipartBody(file, name, formData)
                    val requestBody: RequestBody = ProgressRequestBody(multipart) { sent, total ->
                        if (progressCallbackId.isNotEmpty() && uploadCalls.containsKey(taskId)) {
                            responseCallback(
                                ApiUtils.createCallbackResponse(
                                    progressCallbackId,
                                    uploadProgress(total, sent),
                                )
                            )
                        }
                    }
                    val requestBuilder = Request.Builder().url(url).post(requestBody)
                    header?.keys()?.forEach { key ->
                        requestBuilder.addHeader(key, header.optString(key))
                    }
                    adjustedClient.newCall(requestBuilder.build())
                } catch (e: Exception) {
                    return failImmediately(e.message ?: "invalid parameters")
                }

                uploadCalls[taskId] = call
                CoroutineScope(Dispatchers.IO).launch {
                    try {
                        call.execute().use { response ->
                            if (headersCallbackId.isNotEmpty()) {
                                val headerResult = JSONObject().put(
                                    "header",
                                    JSONObject(mergeResponseHeaders(response.headers)),
                                )
                                responseCallback(ApiUtils.createCallbackResponse(headersCallbackId, headerResult))
                            }
                            val result = JSONObject().apply {
                                put("statusCode", response.code)
                                put("data", response.body?.string() ?: "")
                                put("errMsg", "$UPLOAD:ok")
                            }
                            ApiUtils.invokeSuccess(params, result, responseCallback)
                            ApiUtils.invokeComplete(params, responseCallback, result)
                        }
                    } catch (e: Exception) {
                        val message = if (call.isCanceled()) "abort" else (e.message ?: "network error")
                        val result = JSONObject().put("errMsg", "$UPLOAD:fail $message")
                        ApiUtils.invokeFail(params, result, responseCallback)
                        ApiUtils.invokeComplete(params, responseCallback, result)
                    } finally {
                        uploadCalls.remove(taskId, call)
                    }
                }
                NoneResult()
            }

            ABORT_UPLOAD -> {
                uploadCalls.remove(params.optString("taskId"))?.cancel()
                NoneResult()
            }

            else ->
                super.handleAction(activity, appId, apiName, params, responseCallback)
        }
    }
}

private class ProgressRequestBody(
    private val delegate: RequestBody,
    private val onProgress: (sentBytes: Long, totalBytes: Long) -> Unit,
) : RequestBody() {
    override fun contentType() = delegate.contentType()

    override fun contentLength() = delegate.contentLength()

    override fun writeTo(sink: BufferedSink) {
        val total = contentLength()
        var sent = 0L
        val countingSink = object : ForwardingSink(sink) {
            override fun write(source: Buffer, byteCount: Long) {
                super.write(source, byteCount)
                sent += byteCount
                onProgress(sent, total)
            }
        }.buffer()
        delegate.writeTo(countingSink)
        countingSink.flush()
    }
}
