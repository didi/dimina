package com.didi.dimina.demo

import android.app.Activity
import android.content.Context
import android.os.Bundle
import android.util.Log
import androidx.activity.SystemBarStyle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.view.WindowInsetsControllerCompat
import com.didi.dimina.Dimina
import com.didi.dimina.bean.MiniProgram
import com.didi.dimina.common.Utils
import com.didi.dimina.ui.theme.DiminaAndroidTheme
import org.json.JSONObject

val bgColor = Color(0xFFF5F5F5)
private val primaryTextColor = Color(0xFF1F2329)
private val secondaryTextColor = Color(0xFF4E5969)
private val tertiaryTextColor = Color(0xFF86909C)


/**
 * Author: Doslin
 */
class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val systemBarColor = bgColor.toArgb()
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.light(systemBarColor, systemBarColor),
            navigationBarStyle = SystemBarStyle.light(systemBarColor, systemBarColor)
        )

        // Set the status bar color to bgColor
        @Suppress("DEPRECATION")
        window.statusBarColor = bgColor.toArgb() // Convert Compose Color to ARGB int
        WindowInsetsControllerCompat(window, window.decorView).apply {
            isAppearanceLightStatusBars = true
            isAppearanceLightNavigationBars = true
        }

        setContent {
            DiminaAndroidTheme(darkTheme = false, dynamicColor = false) {
                Scaffold(
                    modifier = Modifier.fillMaxSize(),
                    containerColor = bgColor
                ) { innerPadding ->
                    MiniProgramListScreen(
                        modifier = Modifier.padding(innerPadding)
                    )
                }
            }
        }
    }
}

@Composable
fun MiniProgramListScreen(modifier: Modifier = Modifier) {
    val context = LocalContext.current
    var searchQuery by remember { mutableStateOf("") }
    val allMiniPrograms = remember { context.getMiniProgramsList() }
    val filteredMiniPrograms = remember(searchQuery, allMiniPrograms) {
        if (searchQuery.isEmpty()) {
            allMiniPrograms
        } else {
            allMiniPrograms.filter { it.name.contains(searchQuery, ignoreCase = true) }
        }
    }
    val focusManager = LocalFocusManager.current

    Column(
        modifier = modifier
            .fillMaxSize()
            .clickable(
                onClick = {
                    focusManager.clearFocus()
                },
                indication = null,
                interactionSource = remember { MutableInteractionSource() }
            )
            .background(bgColor)

    ) {
        // Header
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .background(bgColor)
                .padding(16.dp),
            contentAlignment = Alignment.Center
        ) {
            Text(
                text = "星河小程序",
                fontSize = 18.sp,
                fontWeight = FontWeight.Bold,
                color = primaryTextColor
            )
        }
        
        // Search bar
        SearchBar(
            query = searchQuery,
            onQueryChange = { searchQuery = it },
            onSearch = { /* Additional search action if needed */ },
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp)
        )
        
        // App list title
        Text(
            text = "应用列表",
            modifier = Modifier
                .padding(start = 16.dp, bottom = 8.dp),
            fontSize = 16.sp,
            color = secondaryTextColor,
            fontWeight = FontWeight.Medium
        )
        
        // Mini-program list
        MiniProgramList(
            miniPrograms = filteredMiniPrograms,
            onMiniProgramClick = { miniProgram ->
                // Handle mini-program click
                if (context is Activity) {
                    Dimina.getInstance().startMiniProgram(context, miniProgram)
                }
            }
        )
    }
}

@Composable
fun SearchBar(
    query: String,
    onQueryChange: (String) -> Unit,
    onSearch: (String) -> Unit,
    modifier: Modifier = Modifier
) {
    val keyboardController = LocalSoftwareKeyboardController.current
    val focusRequester = remember { FocusRequester() }
    
    Box(
        modifier = modifier
            .fillMaxWidth()
            .height(46.dp)
            .background(Color.White, shape = MaterialTheme.shapes.medium)
            .padding(horizontal = 16.dp),
        contentAlignment = Alignment.CenterStart
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.fillMaxWidth()
        ) {
            Icon(
                imageVector = Icons.Default.Search,
                contentDescription = "Search",
                tint = tertiaryTextColor
            )
            Spacer(modifier = Modifier.width(8.dp))

            BasicTextField(
                value = query,
                onValueChange = onQueryChange,
                textStyle = TextStyle(
                    fontSize = 14.sp,
                    color = primaryTextColor
                ),
                cursorBrush = SolidColor(primaryTextColor),
                singleLine = true,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                keyboardActions = KeyboardActions(onSearch = {
                    onSearch(query)
                    keyboardController?.hide()
                }),
                modifier = Modifier
                    .fillMaxWidth()
                    .focusRequester(focusRequester),
                decorationBox = { innerTextField ->
                    Box(contentAlignment = Alignment.CenterStart) {
                        if (query.isEmpty()) {
                            Text(
                                text = "搜索小程序",
                                fontSize = 14.sp,
                                color = tertiaryTextColor
                            )
                        }
                        innerTextField()
                    }
                }
            )
        }
    }
}

@Composable
fun MiniProgramList(
    miniPrograms: List<MiniProgram>,
    onMiniProgramClick: (MiniProgram) -> Unit
) {
    LazyColumn(
        modifier = Modifier
            .fillMaxWidth()
            .background(Color.White)
    ) {
        itemsIndexed(miniPrograms) { index, miniProgram ->
            MiniProgramItem(
                miniProgram = miniProgram,
                onClick = { onMiniProgramClick(miniProgram) }
            )
            // 仅在不是最后一项时添加分割线
            if (index < miniPrograms.size - 1) {
                HorizontalDivider(
                    modifier = Modifier.padding(start = 72.dp),
                    color = Color(0xFFEEEEEE),
                    thickness = 1.dp
                )
            }
        }
    }
}

@Composable
fun MiniProgramItem(
    miniProgram: MiniProgram,
    onClick: () -> Unit
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(16.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        // Icon with circle background
        Box(
            modifier = Modifier
                .size(48.dp)
                .clip(CircleShape)
                .background(Color(Utils.generateColorFromName(miniProgram.name))),
            contentAlignment = Alignment.Center
        ) {
            Text(
                text = miniProgram.name.substring(0, 1),
                color = Color.White,
                fontSize = 24.sp,
                fontWeight = FontWeight.Bold
            )
        }
        
        Spacer(modifier = Modifier.width(16.dp))
        
        // Mini-program name
        Text(
            text = miniProgram.name,
            fontSize = 16.sp,
            color = primaryTextColor
        )
    }
}

// Read mini programs from assets and generate consistent colors based on name
fun Context.getMiniProgramsList(): List<MiniProgram> {
    try {
        // Read JSON file from assets
        val configResults = assets.list("jsapp")?.map { folder ->
            try {
                val jsonString = assets.open("jsapp/$folder/config.json").bufferedReader().use { it.readText() }
                JSONObject(jsonString)
            } catch (_: Exception) {
                null
            }
        }?:emptyList()

        val miniPrograms = mutableListOf<MiniProgram>()
        
        // Convert to MiniProgram objects with consistent colors based on name
        for (jsonObject in configResults) {
            if (jsonObject == null) {
                continue
            }
            val name = jsonObject.getString("name")
            
            miniPrograms.add(MiniProgram(
                appId =  jsonObject.getString("appId"),
                name = name,
                versionCode = jsonObject.getInt("versionCode"),
                versionName = jsonObject.getString("versionName"),
                path = jsonObject.getString("path"),
                updateManifestUrl = jsonObject.optString("updateManifestUrl", ""),
            ))
        }
        
        return miniPrograms
    } catch (e: Exception) {
        Log.e("MainActivity", "Error reading config.json: ${e.message}")
        // Return empty list if file reading fails
        return emptyList()
    }
}

@Preview(showBackground = true)
@Composable
fun MiniProgramListPreview() {
    DiminaAndroidTheme {
        MiniProgramListScreen()
    }
}
