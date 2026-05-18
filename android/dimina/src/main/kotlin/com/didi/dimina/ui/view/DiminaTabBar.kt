package com.didi.dimina.ui.view

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.graphics.toColorInt
import com.didi.dimina.bean.TabBarConfig
import com.didi.dimina.bean.TabBarItem
import com.skydoves.landscapist.ImageOptions
import com.skydoves.landscapist.coil.CoilImage
import java.io.File

@Composable
fun DiminaTabBar(
    tabBarConfig: TabBarConfig,
    selectedIndex: Int,
    appId: String,
    filesDir: File,
    onSelected: (Int) -> Unit,
    modifier: Modifier = Modifier,
) {
    if (tabBarConfig.list.isEmpty()) {
        return
    }

    val backgroundColor = parseComposeColor(tabBarConfig.backgroundColor, Color.White)
    val borderColor = if (tabBarConfig.borderStyle == "white") Color.White else Color(0xFFE0E0E0)

    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(backgroundColor)
    ) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(0.5.dp)
                .background(borderColor)
        )

        Row(
            modifier = Modifier
                .fillMaxWidth()
                .height(49.dp)
                .background(backgroundColor),
            verticalAlignment = Alignment.CenterVertically
        ) {
            tabBarConfig.list.forEachIndexed { index, item ->
                DiminaTabBarItem(
                    item = item,
                    selected = index == selectedIndex,
                    color = tabBarConfig.color,
                    selectedColor = tabBarConfig.selectedColor,
                    appId = appId,
                    filesDir = filesDir,
                    modifier = Modifier
                        .weight(1f)
                        .fillMaxHeight()
                        .clickable { onSelected(index) }
                )
            }
        }
    }
}

@Composable
private fun DiminaTabBarItem(
    item: TabBarItem,
    selected: Boolean,
    color: String,
    selectedColor: String,
    appId: String,
    filesDir: File,
    modifier: Modifier = Modifier,
) {
    val textColor = parseComposeColor(if (selected) selectedColor else color, Color(0xFF999999))
    val iconPath = if (selected && item.selectedIconPath.isNotEmpty()) {
        item.selectedIconPath
    } else {
        item.iconPath
    }
    val imageModel = remember(iconPath, appId, filesDir.absolutePath) {
        resolveTabBarIconModel(iconPath, appId, filesDir)
    }

    Column(
        modifier = modifier,
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center
    ) {
        if (imageModel != null) {
            CoilImage(
                imageModel = { imageModel },
                imageOptions = ImageOptions(
                    contentScale = ContentScale.Fit,
                    alignment = Alignment.Center
                ),
                modifier = Modifier.size(24.dp)
            )
        } else {
            Spacer(modifier = Modifier.size(24.dp))
        }

        Spacer(modifier = Modifier.height(2.dp))

        Text(
            text = item.text,
            color = textColor,
            fontSize = 10.sp,
            maxLines = 1,
            textAlign = TextAlign.Center,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.width(72.dp)
        )
    }
}

private fun parseComposeColor(value: String, fallback: Color): Color {
    return try {
        Color(value.toColorInt())
    } catch (_: Exception) {
        fallback
    }
}

private fun resolveTabBarIconModel(rawPath: String, appId: String, filesDir: File): Any? {
    if (rawPath.isEmpty()) {
        return null
    }
    if (
        rawPath.startsWith("http://") ||
        rawPath.startsWith("https://") ||
        rawPath.startsWith("file://") ||
        rawPath.startsWith("data:")
    ) {
        return rawPath
    }

    val appRoot = File(filesDir, "jsapp/$appId")
    val appIdPrefix = "/$appId/"
    return when {
        rawPath.startsWith(appIdPrefix) -> File(appRoot, rawPath.removePrefix(appIdPrefix))
        rawPath.startsWith("/") -> File(rawPath)
        else -> File(appRoot, "main/$rawPath")
    }
}
