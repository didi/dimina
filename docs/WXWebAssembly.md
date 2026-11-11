# WXWebAssembly 与 libpag

[API 参考](./API-Reference.md) · [视频解码](./VideoDecoder.md) · [文件系统](./FileSystemManager.md)

逻辑层在业务模块加载前安装全局 `WXWebAssembly`，用于运行 `libpag-miniprogram@4.5.85` 所需的 Wasm。Android、Harmony 的 QuickJS 和 iOS 的 JavaScriptCore 通过 WAMR 解释器执行真实 Wasm；不需要 JIT。必须同时更新 service SDK 和原生 SDK，更新编译器不能让旧容器获得执行能力。

iOS 使用系统 JavaScriptCore 的 `ArrayBuffer.prototype.transfer` 分离扩容前的缓冲区，需要 iOS 17.4 或更高版本，并在运行时检查该方法。此方法的系统支持见 [WebKit 17.4 发布说明](https://webkit.org/blog/15063/webkit-features-in-safari-17-4/)。缺少该能力时不安装 `WXWebAssembly`，`wx.canIUse('WXWebAssembly')` 返回 `false`；SDK 其他功能的最低系统版本不变。Web 使用浏览器自身的 WebAssembly，包内文件读取仍取决于容器文件系统能力。

## 接入 libpag

在导入库前检查能力：libpag 在模块求值时就读取 `WXWebAssembly`，不能等到 `PAGInit` 才检查。

```js
if (!wx.canIUse('WXWebAssembly')) {
  throw new Error('当前容器不支持 PAG Wasm')
}
const { PAGInit } = require('libpag-miniprogram')
const PAG = await PAGInit({ locateFile: file => `/utils/${file}` })
const fs = wx.getFileSystemManager()
const { data } = await fs.readFile({ filePath: '/assets/animation.pag' })
const pagFile = await PAG.PAGFile.load(data)
// 创建播放器时还需要可用的 WebGL Canvas；使用完后调用 pagFile.destroy()。
```

把同一版本库中的 `libpag.wasm.br` 放在小程序包的 `utils/` 目录，编译器会保留 `.wasm`、`.wasm.br`、`.pag` 和 `.mp4` 的相对路径与二进制内容，包含主包、分包和 `miniprogram_npm`；无需依赖静态字符串分析。`locateFile` 返回相对于小程序包的路径；支持前导 `/`，不要使用宿主文件系统的绝对路径。也支持未压缩的 `.wasm` 和当前小程序的 `difile://` 沙箱文件。`.br` 通过 `readCompressedFile({ compressionAlgorithm: 'br' })` 解压，其他文件通过无编码的 `readFile` 读取。HTTP(S) 地址不能直接传给 Wasm API，可先下载到沙箱再加载。

## 已实现的执行契约

| 能力 | 行为 |
| --- | --- |
| `compile(source)` | 接受本地路径、ArrayBuffer 或带偏移的 TypedArray / DataView，返回 Module 的 Promise |
| `instantiate(source, imports)` | 字节或路径返回 `{ module, instance }`；Module 返回 Instance，均为 Promise |
| `validate(bytes)` | 校验二进制是否可由当前引擎执行 |
| `new Module(bytes)`、`Module.imports/exports` | 同步编译及 imports / exports 元数据 |
| `new Instance(module, imports)` | 实例独立链接同步 JavaScript 函数 imports，暴露 `instance.exports` |
| 导出函数 | 支持 i32、i64 / BigInt、f32、f64、多返回值、同步回调、原始 JS 异常与 Wasm trap |
| 导出 Memory | `buffer` 直接共享线性内存；`grow` 保留内容、分离旧 ArrayBuffer，并提供新的 buffer |
| 导出 Table | `length`、`get(index)`；函数身份稳定，可直接调用；空槽返回 `null` |
| 导出 Global | `value`、`valueOf()`，按模块声明限制可写性 |
| 错误类型 | `CompileError`、`LinkError`、`RuntimeError`；越界和扩容失败按相应 API 抛错 |

Wasm 内部的 `memory.grow` 同样会分离旧 buffer，包含增长后立即调用 JavaScript import 的情况。增长后应重新获取 `memory.buffer`；libpag 的 Emscripten 层会更新 HEAP 视图。失败的增长保留原 buffer。并发读取同一路径只共享正在进行的编译，实例及其 imports、内存独立；后续加载会重新读取文件。

`memory.buffer` 的内存由 Wasm 实例持有，调用 `transfer()` 或 `transferToFixedLength()` 会抛出 `TypeError`。需要独立副本时使用 `slice()`；普通 ArrayBuffer 的转移行为不受影响。将 buffer 传给 `validate` 或编译接口不会使原 buffer 失效。

每个小程序的 JSContext / QuickJS context 独立保存 Wasm 模块和实例。销毁或重启时在所属逻辑线程分离缓冲区、释放回调和执行引擎资源。模块、实例在当前小程序存活期间保留；业务应复用初始化后的 PAG，并及时销毁 PAG 文件、播放器等对象，避免重复初始化积累线性内存。

## 支持边界

原生实现覆盖 libpag 4.5.85 使用的函数 imports、模块内定义的 Memory / Table 和导出调用。它不是整个 WebAssembly JavaScript 标准的实现：不支持宿主创建的 `new Memory` / `new Table` / `new Global`、非函数 imports、Table 的 `set` / `grow`、流式编译、共享内存、线程、SIMD、WASI 或多内存。上述构造器会明确拒绝；导出的 Memory / Table / Global 对象可按上表使用。库升级后需重新核对二进制和 JS 包装层。

完整动画依赖逻辑层可用的 WebGL Canvas，含视频序列的 PAG 还依赖 `wx.createVideoDecoder`。Web 需要 OffscreenCanvas / Worker WebGL，视频另需安全上下文、WebCodecs 及相应编码支持。Wasm 初始化成功或 `PAGView.flush()` 返回成功，不能单独保证最终画面、持续播放性能或物理上屏帧率。

接入时须同时更新原生 SDK、Service 和 Render 产物。原生 Wasm 的开发检查入口见 [原生 Wasm 测试说明](../native/wasm/README.md)。

## 资源与生命周期

Harmony 发布包开启混淆时，SDK 的 `consumer-rules.txt` 保留动态 API 方法、Worker 消息字段、WebView 代理和 Node-API 导出名称，以及资源加载的 `bridgeId` / `pagePath`。这些名称跨越字符串调用或序列化边界；被改名会导致分包加载失败、Worker 调用异常或启动遮罩不消失。增加此类接口时同时更新保留规则和 `harmony/scripts/bridge-obfuscation.test.mjs`。

Harmony 的原生定时器在一次性回调执行时移除登记并释放捕获的 JS 引用，取消或销毁后由 libuv 的关闭回调释放原生内存。取帧轮询应及时清理已经结束的定时器，防止回调及其捕获对象持续累积。

示例随包的 libpag 4.5.85 补丁在销毁时先停止取帧轮询，再设置 `isDestroyed`；EOF 保留未消费的尾帧及索引。在容器支持异步缓冲区分配、播放器仍在重复播放时，同一解码器提前准备下一轮的首帧，播放回卷时再接入这份独立数据。每个读取器最多额外保留一帧、8 MiB；超预算取消预取，按正常 seek 解码。暂停后的手动 seek、销毁和迟到回调不会沿用旧预取。重新构建 npm 产物或升级库时需保留补丁或确认上游已提供相应行为，并运行 `harmony/scripts/libpag-video-reader.test.mjs` 和 `harmony/scripts/libpag-buffer-pipeline.test.mjs`；这些是示例依赖补丁，不属于原生 SDK 的公开 API。

## Canvas 传输

原生 Canvas 桥接同步返回 WebGL 查询、资源创建和像素读取结果，等待只发生在逻辑执行线程。Harmony 的 Worker 和 UI 线程通过异步回包保持可运行，并在超时或页面关闭时返回明确错误。

Harmony 原生二进制通道只在 Render 明确声明协议能力并完成握手后传输 Canvas 字节；同步查询、异步发布和脚本共用 FIFO。旧前端、缺少系统接口或握手失败时选择原有链路；原生提交开始后发生失败则取消请求，避免回退重放 GPU 操作。

Android / iOS 的原生 Canvas 传输需要 JSSDK 资源 73 及配套原生 SDK，编码器位于共用的 `native/canvas`。只在 Render 声明编码能力后使用 `rle32-v1`，并在节省至少 25% 时采用；不可压缩数据保留全部原始字节。Android 使用经过握手的 WebMessage ArrayBuffer 端口，iOS 使用页面独占、只消费一次的本地二进制资源。iOS 使用该资源通道是因为公开的 [WKWebView 异步脚本参数](https://developer.apple.com/documentation/webkit/wkwebview/callasyncjavascript(_:arguments:in:in:completionhandler:))不接受 Data。Android 按 [WebMessageCompat 的能力检查要求](https://developer.android.com/reference/androidx/webkit/WebMessageCompat)探测 ArrayBuffer 支持。

脚本、异步纹理上传和后续查询保持 FIFO。查询返回实际 WebGL 结果；UI 线程继续处理 WebView 和回包。异步上传窗口达到 32 项或 8 MiB 时，Service 等待执行确认再继续提交；总预算为 256 项及 64 MiB。页面关闭或复用会释放待处理数据并过滤旧代次；已提交的二进制操作出错后返回错误，不回退重放。旧 Render、缺少系统能力或握手失败时保留原有通道。Android 还要求 Render 明确声明确认回包能力，防止旧版通道因缺少确认而超时。

iOS 本地资源接收器只对同步查询检查提交时的截止时间。已接收的异步发布按 FIFO 执行，其单次执行超时由原生通道在出队时开始计时；排队时间超过 4.5 秒不会使发布过期并关闭整个通道。资源归属、一次性读取、页面代次及队列预算检查继续生效。此行为需要 JSSDK 74 及配套原生 SDK。

JNI 对未提供的对象字段保留缺省语义，数组中的空值和显式 null 保持原样。调用方无需为了跨桥传递而补充 null 字段。

## 纹理解码与像素所有权

Render 对大块 RGBA 的 RLE 恒定尾部上传合并 Base64 与 RLE 解码，使用固定 8 MiB 的浏览器 Wasm 工作区。Base64 主体按 16 字符使用 SIMD 校验与解码，最后一组严格检查填充；RLE 在完整解析所有 token、确认末尾 run 后，选择实际需要展开的行数。输出是独立副本，每次调用后清空工作区。缺少 SIMD、TextEncoder 或 Wasm 执行权限时使用原 JS 解码器，不改变 `WXWebAssembly` 的原生能力范围。

同步纹理上传可以在完整校验 RLE 数据后直接消费临时解码视图，实际 WebGL 调用结束后立即清空工作区；上传异常也会恢复像素存储状态并清理数据。需要保留数据的解码接口仍返回独立副本。只有已展开前缀及省略尾部均为 alpha 255 时，上传才临时关闭 `UNPACK_PREMULTIPLY_ALPHA_WEBGL`，并在 `finally` 中恢复原值；透明像素保留原路径。不缓存前一帧像素，也不改变 GL 查询结果。

原生视频帧仅在 QuickJS 返回独立持有的 ArrayBuffer 时附带 `dataOwned: true`，播放器据此省去额外复制；旧容器及共享缓冲仍执行防御性复制。解码模式 1 在解码线程生成可选的 RLE 候选包，与独立持有的 RGBA 缓冲区一同释放并计入 QuickJS 内存预算。Service 复用前逐字节核对原始像素；调用方修改数据后仍重新编码。候选登记最多 32 项，只保留弱引用。

Harmony 的 NV12 转换预先计算亮度和色度输入对应的双精度值，复用约 8 KiB 的只读表；颜色矩阵的 FMA 顺序、截断及标量路径保持原样。对于 U/V 均为 128 的中性色度像素，ARM64 路径使用额外 2 KiB 的 RGBA 亮度表，其余像素沿用原公式。各平台的视频帧格式及内存边界见[视频解码说明](./VideoDecoder.md)。

输入 EOS 仅表示压缩数据已送完，解码器仍可能在转换或尚未回调的输出中持有尾帧。输入结束、输出尚未结束时，前向 seek 继续排空同一解码器；只有输出 EOS 已完成且没有所需帧时才恢复异步 seek。未到达目标就结束时返回 EOF，不补帧。向后 seek、控制排队及取消沿用正常控制流程。

该浏览器解码内核的 C 源码和生成脚本位于 `fe/packages/common/src/core/canvas-decode-kernel.c` 与 `fe/packages/common/scripts/build-canvas-decode.mjs`。修改 C 源码后，用具备 wasm32 后端的 LLVM clang 与 wasm-ld 重新生成字节码；普通 Vite 构建不需要这两个工具。

## 缓冲区与帧调度

Service 与 Render 协商私有异步缓冲区能力，预分配始终等待实际 GL 创建结果；公共 `createBuffer()` 仍同步返回，缺少能力的容器保留原路径。异步分配最多为 16 个活动请求准备当前对象，并另保留两个未来空缓冲区，保留实际 `null`，失败不重放创建，取消或上下文变化后释放未使用对象。未来对象不提前生成视频帧。

全局播放器所有者只在串行 Wasm 队列内设置和清理；异步准备通过管理器、工厂和读帧器显式传递所有者，避免不同播放器之间互相改写挂起的 Wasm 操作。

异步 WebGL 缓冲区分配在成功、返回 null 与失败后，解除任务闭包对资源及 Promise 完成函数的捕获。Render 根据 WebGL1 绑定及 VAO 引用确认缓冲区已删除且不再被 GPU 容器引用后，通过已有反馈附带释放确认，每次最多 128 条。Service 将代理移入弱引用索引，增量清理已回收的记录；调用方仍持有的对象保留身份、自定义属性及删除后的 GL 错误语义。非当前 VAO 持有的缓冲区继续强引用；缺少 WeakRef、绑定关系不明确或使用呈现上下文时保留原有路径。

原生取帧转换先接管像素缓冲区，再创建结果对象。QuickJS 在自动回收预算中计入即将接管的容量，失败时恢复原有预算及配置方式；释放容量后保留已学习到的自动回收预算，并为硬内存上限保留一半剩余空间，显式设置的 GC 阈值优先。

原生 Canvas 在同页 Render 声明 `animationFrameStream: 1` 后提供私有 RAF 订阅，最多保留 4 个未确认回调。达到上限后等待确认并申请新的浏览器 RAF，不补发旧帧。应用或页面隐藏时取消订阅，恢复后通过新的请求标识过滤迟到回调；暂停、销毁和页面卸载释放订阅。

Harmony 的私有硬件帧订阅由 `OH_NativeVSync` 回调驱动含视频 PAG；公开 `requestAnimationFrame()` 仍使用浏览器时钟。每个订阅最多有四个未确认回调，暂停、隐藏和销毁会取消订阅，迟到回调受订阅代次及所有者存活状态保护。其他平台或原生能力不可用时保留浏览器路径；素材源时钟、播放进度和 WebGL 结果保持原样。

## 性能边界

播放器连续读取常用 WebGL 状态时，Service 将查询合并为一次实际 Render 读回；修改状态、调用扩展、调整画布尺寸或进入下一轮任务后，旧结果失效。Wasm 仍由解释器执行，播放性能取决于素材复杂度、视频编码、纹理传输、系统调度和页面合成。

持续播放时可读取 `PAGView.getDebugData()` 的 `FPS` 与 `flushTime`，首秒和首次资源加载期间的数据不代表稳定播放性能。`PAG.flush` 完成帧率反映运行时执行，不能直接作为物理上屏帧率，也不构成对任意素材持续帧率的保证。

## Web Canvas 与视频

Web 的 `<canvas type="webgl">` 节点通过 OffscreenCanvas 将绘制权交给逻辑 Worker，WebGL 查询、资源创建和像素读取由浏览器同步执行。通过 `createSelectorQuery().fields({ node: true })` 获取节点；传递在 selector 回调之前完成，同一节点重复查询返回同一对象。页面卸载释放 Worker 的 Canvas 和视频解码资源。`wx.createOffscreenCanvas` 在支持该能力的 Web Worker 中也使用浏览器画布。

含视频的 PAG 使用 WebCodecs 解码 MP4；需要 HTTPS 或 localhost 安全上下文，以及浏览器支持对应编码。`wx.canIUse('createVideoDecoder')` 检查接口是否存在，具体视频的编码支持在 `start()` 时检查。libpag 同步写出的 MP4 保存在当前 Worker 的运行时文件空间，随后异步读取和解码；这些文件随小程序关闭消失，不会持久化到 OPFS。详见[文件系统的 Web 范围](./FileSystemManager.md#web-运行时文件)。
