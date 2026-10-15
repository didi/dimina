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

## 支持边界与验证

原生实现覆盖 libpag 4.5.85 使用的函数 imports、模块内定义的 Memory / Table 和导出调用。它不是整个 WebAssembly JavaScript 标准的实现：不支持宿主创建的 `new Memory` / `new Table` / `new Global`、非函数 imports、Table 的 `set` / `grow`、流式编译、共享内存、线程、SIMD、WASI 或多内存。上述构造器会明确拒绝；导出的 Memory / Table / Global 对象可按上表使用。库升级后需重新核对二进制和 JS 包装层。

原生回归使用真实 QuickJS、JavaScriptCore 和完整 libpag 4.5.85 包，验证 Service SDK 导入顺序、`PAGInit`、PAG 文件元数据解析、48 MiB 分配触发扩容、JS imports、Table 调用及两个并发逻辑环境的隔离。另有三端包内读取与 Brotli 加载检查。测试入口见 [原生 Wasm 测试说明](../native/wasm/README.md)。

完整动画依赖逻辑层可用的 WebGL Canvas，含视频序列的 PAG 还依赖 `wx.createVideoDecoder`。Wasm 初始化成功或 `PAGView.flush()` 返回成功，不能单独证明实际绘制正确。当前验收范围如下：

| 平台 | 已验证内容 | 尚未验证或未通过的内容 |
| --- | --- | --- |
| Android / iOS | 模拟器中的真实 libpag 4.5.85、红色 PAG 像素、视频 PAG 多时间点绘制及动画推进 | 真机性能、编码和系统版本兼容性 |
| Harmony | Mate 60 Pro / HarmonyOS 6.1.1.120 真机：真实 libpag 4.5.85、48 MiB 扩容、红色 PAG 像素、16×16 RGBA 视频帧、seek / stop / restart / remove、视频 PAG 0% / 50% / 90% 像素与播放推进；本地 HAP 构建及宿主回归 | 2026-10-15 尾帧 seek 修复后的持续播放采样为 14.76 / 14.25 FPS，未达到素材的 25 FPS；尚未验证反馈者的畅享 90 Plus，也未测量物理上屏帧率 |
| Web | 浏览器中的 `.wasm` / `.wasm.br`、JS imports、内存扩容；真实 libpag 4.5.85 的 PAGInit、48 MiB 分配、红色 PAG 像素、视频 PAG 多进度绘制、seek 与动画推进 | 其他浏览器、显卡和编码组合尚需验证；依赖 OffscreenCanvas / Worker WebGL，视频另需 WebCodecs |

原生 Canvas 桥接同步返回 WebGL 查询、资源创建和像素读取结果，等待只发生在逻辑执行线程。Harmony 的 Worker 和 UI 线程通过异步回包保持可运行，并在超时或页面关闭时返回明确错误。接入时须同时更新原生 SDK、Service 和 Render 产物；上述宿主回归不能替代 Harmony 设备验收。

Harmony 发布包开启混淆时，SDK 的 `consumer-rules.txt` 保留动态 API 方法、Worker 消息字段、WebView 代理和 Node-API 导出名称，以及资源加载的 `bridgeId` / `pagePath`。这些名称跨越字符串调用或序列化边界；被改名会导致分包加载失败、Worker 调用异常或启动遮罩不消失。增加此类接口时同时更新保留规则和 `harmony/scripts/bridge-obfuscation.test.mjs`。开启混淆的最终正常包已在上述真机通过 PAG 功能验证。

Harmony 的原生定时器在一次性回调执行时移除登记并释放捕获的 JS 引用，取消或销毁后由 libuv 的关闭回调释放原生内存。回调中取消自身、批量清理和参数保活由 `harmony/scripts/quickjs-timers.test.mjs` 使用真实 QuickJS / libuv 验证，避免 2 ms 视频取帧轮询持续积累已结束的定时器。

示例随包的 libpag 4.5.85 另保留一处销毁修复：先停止 `VideoReader` 的取帧轮询，再设置 `isDestroyed`。原顺序会使 `destroyVerify` 装饰器拦住清理方法，销毁后持续调用取帧方法并报错。重新构建 npm 产物或升级库时，需保留该修复或确认上游已修复，并运行 `harmony/scripts/libpag-video-reader.test.mjs`。这是示例依赖的补丁，不属于原生 SDK 的公开 API。

2026-10-15 使用官方 `video.pag`（720×1080、25 FPS），每轮预热 5 秒、测量 20 秒。播放器销毁修复在两组中均启用，旧原生定时器在两轮结束后仍登记 1944 / 3222 条记录，新实现均为 2 条；新实现中未再出现已销毁 `VideoReader` 的轮询报错。9 项原生定时器回归和 1 项播放器回归通过，原生回归还检查 libuv 句柄、原生分配及捕获的 ArrayBuffer 回收。

这项资源释放修复没有证明播放帧率改善：同一逐帧诊断方法下，旧原生定时器完成帧率为 14.87 / 14.23 FPS，新实现为 12.90 / 13.13 FPS，仍有 547 / 551 ms 长帧。新实现每次同步 Canvas 桥接平均约 44 ms。以上是本轮 Release 诊断包（关闭宿主调试和混淆）的 `PAG.flush` 完成帧率，不能与前一天的轻量采样直接等同，也不能据资源记录恢复正常认定 #352 卡顿已修复。性能测试结束后恢复正常混淆包、原始资源加载逻辑和不含采样脚本的资源。

播放器连续读取常用 WebGL 状态时，Service 将查询合并为一次真实 Render 读回；修改状态、调用扩展、调整画布尺寸或进入下一轮任务后，旧读回结果失效。此优化减少原生线程间同步往返，不使用预设状态替代实际 WebGL 结果。Wasm 仍由解释器执行，实际帧率需要用目标设备和业务素材测量；可在持续播放时读取 `PAGView.getDebugData()` 的 `FPS` 与 `flushTime`，首秒和首次资源加载期间的数据不代表稳定播放性能。

Render 对大块 RGBA 的 RLE 恒定尾部上传合并 Base64 与 RLE 解码，使用固定 8 MiB 的浏览器 Wasm 工作区。输出是独立副本，每次调用后清空工作区；完整校验数据后才上传。缺少 SIMD、TextEncoder 或 Wasm 执行权限时继续使用原 JS 解码器，不改变 `WXWebAssembly` 的原生能力范围。2026-10-14 的同机对照中，关闭此路径出现 515 / 459 ms 长帧，恢复后为 137 / 135 ms；平均完成帧率仍为 19.89 / 19.70 FPS，不能据此认定 #352 的持续播放性能已经达标。

2026-10-15 后续优化保留了两处 Render 解码改动：Base64 主体按 16 字符使用 SIMD 校验与解码，最后一组仍严格检查填充；从 RLE 尾部选择实际需要展开的行数，并在完整解析所有 token、确认真实末尾 run 后才接受该范围。工作区仍固定为 8 MiB，每次调用后清空已使用部分，不保留前一帧像素。回归覆盖全部 256 种输入字节、SIMD 边界与尾部填充、写入边界，以及伪装成 run 的 literal 尾部。移除行数优化后，目标回归在预期展开范围断言失败，恢复后通过。

同一正常原生实现的临时诊断包按旧 / 新 / 新 / 旧顺序各预热 5 秒、测量 20 秒。旧解码器两轮完成帧率为 16.44 / 12.24 FPS，新解码器为 14.00 / 13.55 FPS；不能据此认定端到端帧率改善。按实际解码调用数加权，解码、返回副本与清理的平均耗时由 7.66 ms 降到 6.22 ms，展开范围由每次 3,110,400 字节降到约 2,027,393 字节；此处不是总工作区容量。新实现仍出现 578 / 555 ms 长帧，#352 的持续播放性能尚未达标。

后续分阶段真机采样定位到视频末尾的重复解码：原生输入已收到 EOS 时，即使转换队列或驱动输出队列仍持有所需尾帧，前向 seek 也被拒绝，播放器重新解码前一个关键帧组。现仅在持有目标时间及之后的真实帧时保留前向 seek；空 EOS 和参数数据不算帧，目标已耗尽、向后 seek、控制排队及取消仍走原有流程。相同素材、预热和测量窗口的两轮对照中，视频准备最长耗时由 451 / 424 ms 降为 109 / 81 ms，整帧最长耗时由 584 / 576 ms 降为 219 / 206 ms，完成帧率由 13.55 / 12.71 FPS 变为 14.76 / 14.25 FPS。像素、seek 和生命周期检查通过；48 项原生 seek 回归通过，其中 3 项新增尾帧用例在旧实现上因拒绝有效目标而失败。此结果确认该尾帧停顿已改善，整体持续播放性能仍未达到 25 FPS。

本次还试验了逐包无损 LZ4、通道重排和 zlib 压缩。LZ4 未证明端到端收益，zlib 两轮降到 8.61 / 7.79 FPS。后续通过资源拦截异步交付 Base64 像素包的试验虽通过像素检查，两轮也仅为 7.85 / 7.15 FPS。这些试验均未保留到框架或最终生成资源中。最终资源为 JSSDK 61（1.0.60），恢复正常混淆、正常资源加载与不含采样脚本的应用包；真机功能验证和性能采样仍分别记录。

该浏览器解码内核的 C 源码和生成脚本位于 `fe/packages/common/src/core/canvas-decode-kernel.c` 与 `fe/packages/common/scripts/build-canvas-decode.mjs`。修改 C 源码后，用具备 wasm32 后端的 LLVM clang 与 wasm-ld 重新生成已提交的字节码；普通 Vite 构建不需要这两个工具。

Web 的 `<canvas type="webgl">` 节点通过 OffscreenCanvas 将绘制权交给逻辑 Worker，WebGL 查询、资源创建和像素读取由浏览器同步执行。通过 `createSelectorQuery().fields({ node: true })` 获取节点；传递在 selector 回调之前完成，同一节点重复查询返回同一对象。页面卸载释放 Worker 的 Canvas 和视频解码资源。`wx.createOffscreenCanvas` 在支持该能力的 Web Worker 中也使用浏览器画布。

含视频的 PAG 使用 WebCodecs 解码 MP4；需要 HTTPS 或 localhost 安全上下文，以及浏览器支持对应编码。`wx.canIUse('createVideoDecoder')` 检查接口是否存在，具体视频的编码支持在 `start()` 时检查。libpag 同步写出的 MP4 保存在当前 Worker 的运行时文件空间，随后异步读取和解码；这些文件随小程序关闭消失，不会持久化到 OPFS。详见[文件系统的 Web 范围](./FileSystemManager.md#web-运行时文件)。
