package com.didi.dimina.bean

import kotlinx.serialization.Serializable

/**
 * Author: Doslin
 */
@Serializable
data class AppConfig(
    val app: App,
    val modules: Map<String, PageModule>
)

@Serializable
data class App(
    val entryPagePath: String? = null,
    val pages: List<String>,
    val window: WindowConfig? = null,
    val tabBar: TabBarConfig? = null,
    val subPackages: List<SubPackage>? = null,
    val networkTimeout: NetworkTimeout? = null,
    val debug: Boolean? = null
)

@Serializable
data class WindowConfig(
    val navigationBarTextStyle: String? = null,
    val navigationBarTitleText: String? = null,
    val navigationBarBackgroundColor: String? = null,
    val backgroundColor: String? = null,
    val navigationStyle: String? = null,
    val homeButton: Boolean? = null,
)

@Serializable
data class TabBarConfig(
    val color: String = "#999999",
    val selectedColor: String = "#1890ff",
    val borderStyle: String = "black",
    val backgroundColor: String = "#FFFFFF",
    val list: List<TabBarItem> = emptyList()
)

@Serializable
data class TabBarItem(
    val pagePath: String,
    val iconPath: String = "",
    val selectedIconPath: String = "",
    val text: String = ""
)

@Serializable
data class SubPackage(
    val root: String,
    val pages: List<String>
)

@Serializable
data class NetworkTimeout(
    val request: Int,
    val connectSocket: Int,
    val uploadFile: Int,
    val downloadFile: Int
)

@Serializable
data class PageModule(
    val navigationBarTitleText: String? = null,
    val root: String? = null,
    val enablePullDownRefresh: Boolean? = null,
    val navigationBarBackgroundColor: String? = null,
    val navigationBarTextStyle: String? = null,
    val backgroundColor: String? = null,
    val navigationStyle: String? = null,
    val homeButton: Boolean? = null,
    val usingComponents: Map<String, String>? = null
)
