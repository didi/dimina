package com.didi.dimina.api.media

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import com.didi.dimina.api.APIResult
import com.didi.dimina.api.AsyncResult
import com.didi.dimina.api.BaseApiHandler
import com.didi.dimina.api.NoneResult
import com.didi.dimina.common.ApiUtils
import com.didi.dimina.common.PathUtils
import com.didi.dimina.common.Utils
import com.didi.dimina.ui.container.DiminaActivity
import com.didi.dimina.ui.container.ImagePreviewActivity
import com.didi.dimina.ui.view.MediaType
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream

/**
 * Author: Doslin
 */
class ImageApi : BaseApiHandler() {
    private companion object {
        const val SAVE_IMAGE_TO_PHOTOS_ALBUM = "saveImageToPhotosAlbum"
        const val PREVIEW_IMAGE = "previewImage"
        const val COMPRESS_IMAGE = "compressImage"
        const val CHOOSE_IMAGE = "chooseImage"
    }

    override val apiNames =
        setOf(SAVE_IMAGE_TO_PHOTOS_ALBUM, PREVIEW_IMAGE, COMPRESS_IMAGE, CHOOSE_IMAGE)

    override fun handleAction(
        activity: DiminaActivity,
        appId: String,
        apiName: String,
        params: JSONObject,
        responseCallback: (String) -> Unit,
    ): APIResult {
        return when (apiName) {
            SAVE_IMAGE_TO_PHOTOS_ALBUM -> {
                val filePath = params.optString("filePath")
                if (PathUtils.isLegalPath(filePath)) {
                    Utils.saveImageToGallery(activity, PathUtils.pathToReal(activity, filePath, appId))
                    AsyncResult(JSONObject().apply {
                        put("errMsg", "$SAVE_IMAGE_TO_PHOTOS_ALBUM:ok")
                    })
                } else {
                    AsyncResult(JSONObject().apply {
                        put("errMsg", "$SAVE_IMAGE_TO_PHOTOS_ALBUM:fail invalid file path")
                    })
                }
            }

            PREVIEW_IMAGE -> {
                val urls = params.optJSONArray("urls")
                if (urls != null && urls.length() > 0) {
                    var current = params.optString("current", urls.getString(0))
                    var showMenu = params.optBoolean("showmenu", true) // 是否显示长按菜单
                    val urlList = mutableListOf<String>()
                    for (i in 0 until urls.length()) {
                        urlList.add(urls.optString(i))
                    }
                    ImagePreviewActivity.launch(activity, urlList, current, showMenu)
                    AsyncResult(JSONObject().apply {
                        put("errMsg", "$PREVIEW_IMAGE:ok")
                    })
                } else {
                    AsyncResult(JSONObject().apply {
                        put("errMsg", "$PREVIEW_IMAGE:fail invalid url")
                    })
                }
            }

            COMPRESS_IMAGE -> {
                val src = params.optString("src")
                if (PathUtils.isLegalPath(src)) {
                    val quality = params.optInt("quality", 80)
                    val bitmap = BitmapFactory.decodeFile(PathUtils.pathToReal(activity, src, appId))
                    val compressedFile = File.createTempFile(
                        "IMG_${System.currentTimeMillis()}",
                        ".jpg",
                        activity.cacheDir
                    )
                    val outputStream = FileOutputStream(compressedFile)
                    bitmap.compress(Bitmap.CompressFormat.JPEG, quality, outputStream)
                    outputStream.flush()
                    outputStream.close()
                    val virtualPath = PathUtils.pathToVirtual(compressedFile)
                    AsyncResult(JSONObject().apply {
                        put("tempFilePath", virtualPath)
                        put("errMsg", "$COMPRESS_IMAGE:ok")
                    })
                } else {
                    AsyncResult(JSONObject().apply {
                        put("errMsg", "$COMPRESS_IMAGE:fail")
                    })
                }
            }

            CHOOSE_IMAGE -> {
                val count = params.optInt("count", 9)  // 获取图片数量，默认9张
                val sizeType = params.optJSONArray("sizeType") ?: JSONArray().apply {
                    put("original")
                    put("compressed")
                } // TODO: 是否压缩所选文件

                val sourceType = params.optJSONArray("sourceType") ?: JSONArray().apply {
                    put("album")
                    put("camera")
                }

                // 检查是否允许从相册或相机选择
                val allowAlbum =
                    (0 until sourceType.length()).any { sourceType.getString(it) == "album" }
                val allowCamera =
                    (0 until sourceType.length()).any { sourceType.getString(it) == "camera" }

                if (!allowAlbum && !allowCamera) {
                    return AsyncResult(JSONObject().apply {
                        put("errMsg", "$CHOOSE_IMAGE:fail invalid sourceType")
                    })
                }
                activity.handleChooseMedia(
                    type = MediaType.IMAGE,
                    count = count,
                    allowAlbum = allowAlbum,
                    allowCamera = allowCamera
                ) { imagePaths ->
                    val tempFilePaths = JSONArray()
                    val tempFiles = JSONArray()

                    imagePaths.take(count).forEach { path ->
                        val file = File(PathUtils.pathToReal(activity, path, appId))
                        tempFilePaths.put(path)
                        tempFiles.put(JSONObject().apply {
                            put("path", path)
                            put("size", file.length())
                        })
                    }
                    val result = JSONObject().apply {
                        put("errMsg", "$CHOOSE_IMAGE:ok")
                        put("tempFilePaths", tempFilePaths)
                        put("tempFiles", tempFiles)
                    }
                    ApiUtils.invokeSuccess(params, result, responseCallback)
                    ApiUtils.invokeComplete(params, responseCallback)
                }
                NoneResult()
            }

            else ->
                super.handleAction(activity, appId, apiName, params, responseCallback)
        }
    }


}
