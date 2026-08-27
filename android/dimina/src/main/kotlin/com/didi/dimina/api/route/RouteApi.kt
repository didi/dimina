package com.didi.dimina.api.route

import com.didi.dimina.api.APIResult
import com.didi.dimina.api.AsyncResult
import com.didi.dimina.api.BaseApiHandler
import com.didi.dimina.common.ApiUtils
import com.didi.dimina.common.LogUtils
import com.didi.dimina.core.BundledMiniProgramResolver
import com.didi.dimina.core.MiniApp
import com.didi.dimina.ui.container.DiminaActivity
import org.json.JSONObject

internal fun miniProgramSuccessResult(apiName: String, afterComplete: () -> Unit): AsyncResult {
    return AsyncResult(
        value = JSONObject().apply { put("errMsg", "$apiName:ok") },
        afterComplete = afterComplete,
        completeCarriesResult = true,
    )
}

internal fun miniProgramErrorResult(apiName: String, errorMessage: String): AsyncResult {
    return ApiUtils.createErrorResponse(apiName, errorMessage).copy(completeCarriesResult = true)
}

/**
 * Runs one cross-mini-program operation behind [guard], which admits a single operation at a time.
 *
 * The operation itself runs from `afterComplete`, once success and complete have already reached
 * the page - suspending the opener's runtime any earlier would strand those callbacks. A failure
 * past that point therefore has no `fail` left to report, and letting it out would take the JS
 * runtime's message loop down with it, so it is contained here. Everything the operation can throw
 * rolls its own state back first (`MiniApp.openApp` drops the runtime it registered,
 * `DiminaActivity` restores the suspended opener), leaving the opener usable and the call
 * retryable.
 */
internal fun miniProgramOperationResult(
    apiName: String,
    guard: MiniProgramOperationGuard,
    action: () -> Unit,
): AsyncResult {
    if (!guard.tryBegin()) {
        return miniProgramErrorResult(apiName, "another mini program operation is in progress")
    }
    return miniProgramSuccessResult(apiName) {
        try {
            action()
        } catch (error: Exception) {
            LogUtils.e("RouteApi", "$apiName failed after success was reported: ${error.message}")
        } finally {
            guard.end()
        }
    }
}

/**
 * Navigation API implementation
 * Author: Doslin
 *
 * Handles all page navigation operations:
 * - navigateTo: Navigate to a new page
 * - redirectTo: Replace current page with a new one
 * - navigateBack: Navigate back to the previous page
 */
class RouteApi : BaseApiHandler() {
    private val miniProgramOperationGuard = MiniProgramOperationGuard()

    private companion object {
        const val NAVIGATE_TO = "navigateTo"
        const val REDIRECT_TO = "redirectTo"
        const val NAVIGATE_BACK = "navigateBack"
        const val RE_LAUNCH = "reLaunch"
        const val SWITCH_TAB = "switchTab"
        const val NAVIGATE_TO_MINI_PROGRAM = "navigateToMiniProgram"
        const val NAVIGATE_BACK_MINI_PROGRAM = "navigateBackMiniProgram"
        const val EXIT_MINI_PROGRAM = "exitMiniProgram"
        const val RESTART_MINI_PROGRAM = "restartMiniProgram"
    }

    override val apiNames = setOf(
        NAVIGATE_TO,
        REDIRECT_TO,
        NAVIGATE_BACK,
        RE_LAUNCH,
        SWITCH_TAB,
        NAVIGATE_TO_MINI_PROGRAM,
        NAVIGATE_BACK_MINI_PROGRAM,
        EXIT_MINI_PROGRAM,
        RESTART_MINI_PROGRAM,
    )

    override fun handleAction(
        activity: DiminaActivity,
        appId: String,
        apiName: String,
        params: JSONObject,
        responseCallback: (String) -> Unit,
    ): APIResult {
        return when (apiName) {
            NAVIGATE_TO -> {
                val url = params.optString("url", "")
                if (url.isEmpty()) {
                    return ApiUtils.createErrorResponse(apiName, "URL cannot be empty")
                }
                if (activity.isTabBarPageUrl(url)) {
                    return ApiUtils.createErrorResponse(
                        apiName,
                        "can not navigateTo a tabbar page: $url"
                    )
                }

                val miniProgram = activity.getMiniProgram()
                MiniApp.getInstance().openApp(
                    activity,
                    miniProgram.copy(
                        root = false,
                        path = url,
                    ),
                )
                AsyncResult(JSONObject().apply {
                    put("errMsg", "$NAVIGATE_TO:ok")
                })
            }

            // 关闭当前页面，跳转到应用内的某个页面
            REDIRECT_TO -> {
                val url = params.optString("url", "")
                if (url.isEmpty()) {
                    return ApiUtils.createErrorResponse(apiName, "URL cannot be empty")
                }
                if (activity.isTabBarPageUrl(url)) {
                    return ApiUtils.createErrorResponse(
                        apiName,
                        "can not redirectTo a tabbar page: $url"
                    )
                }

                // 在当前 Activity 中更新路径
                activity.updatePath(url)

                AsyncResult(JSONObject().apply {
                    put("errMsg", "$REDIRECT_TO:ok")
                })
            }

            NAVIGATE_BACK -> {
                // Implementation of navigating back
                activity.runOnUiThread {
                    activity.onBackPressed()
                }

                // Send success response
                AsyncResult(JSONObject().apply {
                    put("errMsg", "$NAVIGATE_BACK:ok")
                })
            }

            // 关闭所有页面，打开到应用内的某个页面
            RE_LAUNCH -> {
                val url = params.optString("url", "")
                if (url.isEmpty()) {
                    return ApiUtils.createErrorResponse(apiName, "URL cannot be empty")
                }

                activity.reLaunchTo(url)
                AsyncResult(JSONObject().apply {
                    put("errMsg", "$RE_LAUNCH:ok")
                })
            }

            SWITCH_TAB -> {
                val url = params.optString("url", "")
                if (url.isEmpty()) {
                    return ApiUtils.createErrorResponse(apiName, "URL cannot be empty")
                }
                if (!activity.switchTab(url)) {
                    return ApiUtils.createErrorResponse(
                        apiName,
                        "can not switchTab to a non-tabbar page: $url"
                    )
                }

                AsyncResult(JSONObject().apply {
                    put("errMsg", "$SWITCH_TAB:ok")
                })
            }

            NAVIGATE_TO_MINI_PROGRAM -> {
                val request = MiniProgramRouteContract.navigateTo(params, appId).getOrElse {
                    return miniProgramErrorResult(apiName, it.message ?: "invalid options")
                }
                val miniApp = MiniApp.getInstance()
                if (miniApp.isRunning(request.appId)) {
                    return miniProgramErrorResult(
                        apiName,
                        "target mini program is already running",
                    )
                }
                val target = BundledMiniProgramResolver.resolve(
                    context = activity,
                    appId = request.appId,
                    requestedPath = request.path,
                ).getOrElse {
                    return miniProgramErrorResult(
                        apiName,
                        it.message ?: "target mini program is not bundled",
                    )
                }.copy(
                    scene = MiniProgramRouteContract.SCENE_OPENED_BY_MINI_PROGRAM,
                    openerAppId = appId,
                    referrerExtraData = request.extraData.toString(),
                    envVersion = request.envVersion,
                )

                withMiniProgramOperation(apiName) {
                    activity.navigateToMiniProgram(target)
                }
            }

            NAVIGATE_BACK_MINI_PROGRAM -> {
                val openerAppId = activity.getMiniProgram().openerAppId
                if (openerAppId == null || !MiniApp.getInstance().isRunning(openerAppId)) {
                    return miniProgramErrorResult(
                        apiName,
                        "no opener mini program",
                    )
                }
                val extraData = MiniProgramRouteContract.navigateBackExtraData(params).getOrElse {
                    return miniProgramErrorResult(apiName, it.message ?: "invalid options")
                }
                withMiniProgramOperation(apiName) {
                    activity.navigateBackMiniProgram(extraData)
                }
            }

            EXIT_MINI_PROGRAM -> withMiniProgramOperation(apiName) {
                activity.exitMiniProgram()
            }

            RESTART_MINI_PROGRAM -> {
                val path = MiniProgramRouteContract.restartPath(params).getOrElse {
                    return miniProgramErrorResult(apiName, it.message ?: "invalid options")
                }
                withMiniProgramOperation(apiName) {
                    activity.restartMiniProgram(path)
                }
            }

            else -> {
                super.handleAction(activity, appId, apiName, params, responseCallback)
            }
        }
    }

    private fun withMiniProgramOperation(apiName: String, action: () -> Unit): AsyncResult {
        return miniProgramOperationResult(apiName, miniProgramOperationGuard, action)
    }
}
