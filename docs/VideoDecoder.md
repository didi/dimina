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

支持 `on` / `off` 多监听及 `start`、`stop`、`seek`、`ended` 事件。`ended` 在最后一帧取出后、下一次取帧时触发一次；`seek` 或重新 `start` 后可再次触发。暂不发送 `bufferchange`。原生解码器内部最多预取两帧；Web 在两帧就绪后暂停提交输入，浏览器解码重排和异步像素复制合计最多保留八个输出帧。每个小程序最多保留四个解码器；单帧不超过 2,097,152 像素，单边不超过 4096。超过限制会报错，不会隐式缩放。`remove` 立即使对象失效，未完成的控制操作不能恢复该对象。小程序销毁或重启时资源也会释放；Web 页面卸载也会移除所属解码器。

`stop()` 可以取消尚未完成的 `start()`，被取消的 Promise 会拒绝；旧控制回复不会恢复播放状态。停止完成后可以重新 `start()`。iOS 的停止和移除操作会取消正在进行的远程下载。

## Web 支持范围

Web 要求 HTTPS 或 localhost 安全上下文，浏览器提供 `VideoDecoder`、`EncodedVideoChunk` 和 `OffscreenCanvas`。`canIUse` 检查这些接口，不能保证任意编码都可解码；`start` 会调用浏览器的编码能力检查，失败时拒绝 Promise。已验证 H.264 MP4 和完整 libpag 4.5.85 的视频 PAG，其他编码、浏览器和显卡组合需要分别验收。

支持 MP4 包内路径、异步文件系统可读的沙箱文件和 HTTP(S) 地址，远程地址遵守浏览器 CORS。单个源文件最多 128 MiB；超限报错。MP4 保留解码顺序、PTS 和前置编辑时间偏移，按 WebCodecs 的呈现顺序输出帧，并串行复制 RGBA 以保留顺序。一个编码样本不保证产生一个输出帧。seek 从前一个关键帧解码并丢弃目标时间之前的帧。多段或变速的 MP4 编辑列表明确拒绝。`stop` / `remove` 取消远程读取和待处理控制，关闭旧解码器并丢弃过期输出。

libpag 写出的 MP4 使用 Worker 运行时文件，关闭小程序后消失。Web 不提供音轨或 `bufferchange`，文件持久化和同步读取范围见[文件系统说明](./FileSystemManager.md#web-运行时文件)。

## libpag 能力边界

不依赖 Wasm、使用视频序列的 [libpag lite 微信版本](https://github.com/Tencent/libpag/blob/main/web/lite/wechat/README.md) 可用此接口接入；其上游限制为单个 BMP 视频序列，仍需用实际 PAG 文件在三端验收。

完整 `libpag-miniprogram@4.5.85` 所需的逻辑层 `WXWebAssembly` 已接入真实 Wasm 引擎，支持业务模块导入前初始化、JS imports、Memory / Table 和包内 `.wasm.br` 加载。平台要求、接入示例和执行范围见 [WXWebAssembly 说明](./WXWebAssembly.md)。Render WebView 的 WebAssembly 与逻辑层执行能力分别检测。

Wasm 初始化及 PAG 数据解析已有真实库回归；完整播放器还需要可用的逻辑层 WebGL Canvas。含视频序列的 PAG 需要同时验证本接口输出、纹理上传和动画播放，三端真机效果仍需验收。
