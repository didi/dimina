# 复用宿主 App 的图片

Android、iOS 和 HarmonyOS 宿主可将已有图片或图片目录注册到 SDK。小程序的 `<image>` 使用统一的 `dimina-image://` 地址，无需按平台分支，也无需把图片放进小程序 ZIP 或复制到各个小程序的 `usr` 目录。

## 小程序引用

```html
<!-- 单张图片 ID -->
<image src="dimina-image://device_light_on" mode="aspectFit" />
<!-- 目录 ID + 相对路径，支持子目录 -->
<image src="dimina-image://icons/device/light_on.svg" mode="aspectFit" />
<!-- 也支持数据绑定、动态切换和 lazy-load -->
<image src="{{iconSource}}" lazy-load />
```

ID 区分大小写，允许 1～128 个英文字母、数字、下划线或连字符。目录内使用 `/` 分隔的相对路径，可包含中文、空格或其 URI 编码；不接受 `.`、`..`、空路径段、反斜线、控制字符和嵌套百分号编码。查询参数和片段不参与资源查找。

支持 PNG、JPG/JPEG、WebP、SVG、GIF、BMP、ICO、AVIF 的 MIME 类型；实际解码能力由设备 WebView 决定。SVG 应是可独立显示的图片，不依赖相对路径引用的外部资源。框架保留原有 `mode`、加载/错误事件和懒加载行为。

## 宿主注册

在启动小程序前注册。一个 ID 对应一张图片或一个目录；相同 ID 再注册会替换原映射。

### Android

```kotlin
import com.didi.dimina.HostImages

HostImages.registerAsset("device_light_on", applicationContext, "images/light_on.png")
HostImages.registerAssetDirectory("icons", applicationContext, "images/icons")

// 也可以使用宿主已有文件、目录或编码图片资源。
HostImages.registerFile("downloaded", imageFile)
HostImages.registerDirectory("downloaded-icons", imageDirectory)
HostImages.registerResource("badge", applicationContext, R.drawable.badge)
```

`registerResource` 适用于 PNG/WebP 等编码图片及 `res/raw` 图片；Android VectorDrawable XML 不是 WebView 图片格式，不能直接注册。assets 目录保留原始文件和子目录，不会被展开到小程序磁盘目录。

### iOS

```swift
import Dimina
import UIKit

if let url = Bundle.main.url(forResource: "light_on", withExtension: "png") {
    try DMPHostImages.register("device_light_on", fileURL: url)
}
if let directory = Bundle.main.url(forResource: "HostIcons", withExtension: nil) {
    try DMPHostImages.registerDirectory("icons", directoryURL: directory)
}

// 编译进 Assets.xcassets 的图片可以通过 UIImage 注册。
if let image = UIImage(named: "badge") {
    try DMPHostImages.registerImage("badge", image: image)
}
```

文件和目录可来自 `Bundle.main`、其他 Bundle 或宿主可读目录。目录映射需在打包时保留目录结构。普通文件直接返回原始图片数据；`registerImage` 在请求时于内存中编码为 PNG，不写入磁盘，适用于静态图片，不保留原始文件格式或动画。

### HarmonyOS

```typescript
import { DMPHostImages } from '@didi-dimina/dimina';

DMPHostImages.registerRawFile("device_light_on", $rawfile("images/light_on.png"), "png");
// 在 UIAbility 中使用该资源所属模块的 ResourceManager。
DMPHostImages.registerRawDirectory("icons", this.context.resourceManager, "images/icons");

DMPHostImages.registerFile("downloaded", imageFilePath);
DMPHostImages.registerDirectory("downloaded-icons", imageDirectoryPath);
```

`registerRawFile` 的第三个参数为格式（不带点，默认 `png`），应与资源内容一致；例如 SVG 传 `svg`。目录映射根据每次请求的文件后缀确定 MIME 类型。rawfile 目录相对于该模块的 `resources/rawfile`；SDK 使用传入的 ResourceManager 直接读取资源。

## 生命周期与范围

- 注册表属于宿主进程，已注册内容可供所有小程序读取。只注册希望共享的图片或图片目录；目录映射不允许通过路径遍历或指向目录外的符号链接访问其他宿主文件，也不返回非图片后缀的文件。
- Android 使用 `HostImages.unregister(id)`，iOS 和 HarmonyOS 使用 `DMPHostImages.unregister(id)` 移除映射；资源缺失、未注册、路径非法或读取失败时，`<image>` 触发原有错误事件，不回退到网络或小程序包。
- 已解码或被 WebView 缓存的图片不会因注销立即消失。使用期间保持文件与映射稳定；更新资源时使用新 ID 或版本路径。该功能避免磁盘重复打包和拷贝，不保证不同 WebView 共享图片解码内存。
- 此协议是 Dimina 的原生宿主扩展，当前用于 `<image>`，不扩展文件系统 API、`wx.getImageInfo`、`wx.previewImage` 或 Canvas；Web、Desktop 和微信客户端不提供这些原生注册资源。

## 构建与接入

需要同时更新原生 SDK 和包含新 Image 组件的 JSSDK；编译器也应更新，避免把目录协议地址误收集为包内图片。仓库构建步骤见[共享资源说明](../shared/README.md)：构建前端、生成 JSSDK，再构建相应原生 SDK。仅替换原生 SDK 无法让旧版 Image 组件识别此协议。
