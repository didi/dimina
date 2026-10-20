# 视频逐帧解码

[API 参考](./API-Reference.md) · [文件系统](./FileSystemManager.md)

`wx.createVideoDecoder()` 在 Android、iOS、Harmony 的原生容器中提供逐帧视频解码。需要同时更新 service SDK 和原生 SDK；现有发布包不会因为更新编译器而获得该能力。Web 使用浏览器的 WebCodecs，使用前通过 `wx.canIUse('createVideoDecoder')` 检查。

创建对象时不开始解码；`start`、`seek`、`stop`、`remove` 返回 Promise；`getFrameData` 同步返回下一帧或 `null`。内部使用 Android MediaExtractor / MediaCodec、iOS AVAssetReader、Harmony AVSource / AVDemuxer / AVCodec；Web 使用 MP4Box 解析 MP4 和 WebCodecs 解码。

```js
if (!wx.canIUse('createVideoDecoder')) throw new Error('当前容器不支持视频解码')
const decoder = wx.createVideoDecoder()
decoder.on('ended', () => console.log('全部帧已取出'))
await decoder.start({ source: '/assets/video.mp4', mode: 1 })

// 在播放器自己的渲染循环中调用；null 表示当前没有可用帧。
function nextFrame() {
  const frame = decoder.getFrameData()
  if (frame) {
    const rgba = new Uint8Array(frame.data)
    // 使用 frame.width、frame.height 上传 WebGL 纹理或绘制 Canvas。
  }
}
await decoder.seek(500) // 毫秒；清空旧帧，从目标时间开始输出。
// 离开页面或不再使用时释放资源。
await decoder.remove()
```

`source` 支持小程序包内路径、当前小程序的 `difile://` 用户或临时文件以及 HTTP(S) 视频源。Android、iOS 远程文件先下载到当前小程序临时目录；iOS 在停止、重新开始、移除或加载失败时删除本次下载文件。Harmony 使用系统媒体源加载能力。网络失败、无视频轨、系统不支持的编码或资源限制会拒绝控制操作，运行中解码失败由 `getFrameData()` 抛出。

`mode: 1` 是默认值，尽快解码；`mode: 0` 按帧的 PTS 控制输出速度，计时从取出第一帧开始。`getFrameData()` 返回紧密排列的 RGBA `ArrayBuffer`、实际帧宽高和微秒 `pts` / `pkPts`。只有系统提供 DTS 时才返回 `dts` / `pkDts`，不能依赖这些可选字段。控制操作执行期间返回 `null`。每次返回的像素缓冲区独立于后续帧。各系统对视频旋转、色彩空间、网络源和编码格式的处理需要在目标设备验证；此接口不输出音轨。

Harmony 在创建解码器前检查视频尺寸和 NV12 输出能力，优先使用系统推荐及硬件解码器；不适用时选择支持该素材的软件解码器。例如，硬件解码器的最小尺寸可能大于视频尺寸。没有可用解码器时，`start()` 明确报告编码、尺寸及输出格式的支持限制。

Harmony 的新版原生 SDK 直接在所属逻辑线程创建帧的 `ArrayBuffer`，避免逐帧经过 Worker、JSON 和 Base64 转换；解码器控制仍异步执行，取帧不等待系统解码。需要同步更新 Service 与原生 SDK 才能使用此路径；旧容器继续使用兼容的取帧通道。

Android、iOS 的新版原生 SDK 也以二进制交付视频帧：Android 将独立的 RGBA `ByteArray` 通过原生值桥接转为 `ArrayBuffer`，iOS 将 RGBA `Data` 在所属 JS 线程转为 `ArrayBuffer`。两端均省去像素的 Base64 编解码，Android 同时省去帧结果的 JSON 字符串序列化。需配套支持二进制帧的 Service；旧原生容器的 Base64 返回格式仍由 Service 兼容。

Android 的 YUV 转换在 C++ 中同步读取解码器的直接缓冲区，复用平面步幅和相邻像素的色度计算，保留裁切、BT.601 / BT.709、全范围 / 有限范围的原有字节结果。JNI 校验 position、limit、步幅和最后一个采样位置，输出独立的 RGBA 字节；非直接缓冲区保留 Kotlin 路径。iOS 使用 Accelerate 交换 BGRA 通道，正确处理源行填充并保留 alpha。解码器仍最多预取两帧，已返回的缓冲区在后续取帧、seek、stop 和 remove 后保持独立有效。

支持 `on` / `off` 多监听及 `start`、`stop`、`seek`、`ended` 事件。`ended` 在最后一帧取出后、下一次取帧时触发一次；`seek` 或重新 `start` 后可再次触发。暂不发送 `bufferchange`。原生解码器内部最多预取两帧；Web 在两帧就绪后暂停提交输入，浏览器解码重排和异步像素复制合计最多保留八个输出帧。每个小程序最多保留四个解码器；单帧不超过 2,097,152 像素，单边不超过 4096。超过限制会报错，不会隐式缩放。`remove` 立即使对象失效，未完成的控制操作不能恢复该对象。小程序销毁或重启时资源也会释放；Web 页面卸载也会移除所属解码器。

`stop()` 可以取消尚未完成的 `start()`，被取消的 Promise 会拒绝；旧控制回复不会恢复播放状态。停止完成后可以重新 `start()`。iOS 的停止和移除操作会取消正在进行的远程下载。

## Android / iOS 取帧验证

2026-10-19，同机对照使用 H.264、720×1080、120 帧、`mode: 1`，前 8 帧预热。下表是解码、RGBA 转换和交付 JS `ArrayBuffer` 的取帧吞吐，包含测试驱动开销，不是完整 PAG 播放或物理上屏帧率。

| 真机 | 旧路径 | 二进制交付及像素转换优化后 |
| --- | --- | --- |
| PLK110 / Android 16 | 约 7.62 FPS | 两轮约 28.74 / 28.54 FPS |
| iPhone 14 Pro / iOS 27.0.1 | 两轮约 3.66 / 3.50 FPS | 两轮约 273.84 / 255.71 FPS |

Android 用真实 MediaCodec 和 QuickJS 原生桥；iOS 用真实 AVAssetReader、JavaScriptCore 和随包 Service SDK，两组均为 Release 优化、启用测试所需的 DEBUG 编译条件，每帧在 JS 任务间让出 2 ms。iOS 用同一解码器 seek 后测量第二轮，检查返回缓冲区在 stop / remove 后仍有效。移除二进制交付的旧路径在原生字节类型断言处失败，恢复后通过。Android 的 359 项单元测试、2 项真机回归、Service 的 11 项视频接口回归，以及 iOS 真机 7 项 XCTest 和 4 组像素校验通过；iOS 像素转换另通过独立主机 Address Sanitizer 检查。其他机型、编码及完整 PAG 场景的持续播放性能需分别验证。

### Android Debug 像素转换

2026-10-19，在 PLK110 / Android 16 上，解码测试的 CPU 采样中约 89% 开销位于 Kotlin 逐像素转换及其 `DirectByteBuffer.get`、边界检查、`coerceIn` 和属性访问。将该循环移到现有原生库后，仍保留 `android:debuggable=true`、WebView 远程调试和原有调试配置。使用双精度运算并禁止浮点乘加收缩，保持已有像素的截断和舍入结果；原生端不保留解码器缓冲区地址。

不挂 CPU 采样的前后对照中，720×1080 取帧吞吐从 13.25 FPS 提升到 149.00 / 150.22 FPS，前 8 帧预热，总计 120 帧；Release 的同一路径为 151.55 FPS。完整视频 PAG 使用真实 libpag 4.5.85 和官方 `video.pag`，预热 2 秒后各采样约 10 秒：本轮旧 Kotlin Debug 路径为 3.00 FPS（此前不同轮次为 6.90–7.80 FPS），原生转换的两轮 Debug 为 25.05 / 25.00 FPS。0% / 50% / 90% 进度的已呈现画布像素哈希与旧路径一致。此处为完成的 `PAG.flush`，尚未验收长期连续源帧和物理上屏帧率。

Debug / Release 各 359 项单元测试通过；Debug 的 7 项真机回归及 Release 的 5 项像素与解码回归通过。JNI 用例逐字节比较原 Kotlin 算法，覆盖只读及切片缓冲区、非零 position、平面及交错色度、奇数裁切、颜色范围、无效步幅、截短平面、所有权和堆缓冲区回退。主机原生回归的 360 组颜色、布局及所有权校验和非法元数据检查通过 Address Sanitizer / UndefinedBehaviorSanitizer；入口为 `native/media/tests`。完整 PAG 测试保持屏幕唤醒并检查 WebView 前台焦点，避免把后台暂停计入性能数据。

## Web 支持范围

Web 要求 HTTPS 或 localhost 安全上下文，浏览器提供 `VideoDecoder`、`EncodedVideoChunk` 和 `OffscreenCanvas`。`canIUse` 检查这些接口，不能保证任意编码都可解码；`start` 会调用浏览器的编码能力检查，失败时拒绝 Promise。已验证 H.264 MP4 和完整 libpag 4.5.85 的视频 PAG，其他编码、浏览器和显卡组合需要分别验收。

支持 MP4 包内路径、异步文件系统可读的沙箱文件和 HTTP(S) 地址，远程地址遵守浏览器 CORS。单个源文件最多 128 MiB；超限报错。MP4 保留解码顺序、PTS 和前置编辑时间偏移，按 WebCodecs 的呈现顺序输出帧，并串行复制 RGBA 以保留顺序。一个编码样本不保证产生一个输出帧。seek 从前一个关键帧解码并丢弃目标时间之前的帧。多段或变速的 MP4 编辑列表明确拒绝。`stop` / `remove` 取消远程读取和待处理控制，关闭旧解码器并丢弃过期输出。

libpag 写出的 MP4 使用 Worker 运行时文件，关闭小程序后消失。Web 不提供音轨或 `bufferchange`，文件持久化和同步读取范围见[文件系统说明](./FileSystemManager.md#web-运行时文件)。

## libpag 能力边界

不依赖 Wasm、使用视频序列的 [libpag lite 微信版本](https://github.com/Tencent/libpag/blob/main/web/lite/wechat/README.md) 可用此接口接入；其上游限制为单个 BMP 视频序列，仍需用实际 PAG 文件在三端验收。

完整 `libpag-miniprogram@4.5.85` 所需的逻辑层 `WXWebAssembly` 已接入真实 Wasm 引擎，支持业务模块导入前初始化、JS imports、Memory / Table 和包内 `.wasm.br` 加载。平台要求、接入示例和执行范围见 [WXWebAssembly 说明](./WXWebAssembly.md)。Render WebView 的 WebAssembly 与逻辑层执行能力分别检测。

Wasm 初始化及 PAG 数据解析已有真实库回归；完整播放器还需要可用的逻辑层 WebGL Canvas。含视频序列的 PAG 需要同时验证本接口输出、纹理上传和动画播放，三端真机效果仍需验收。
