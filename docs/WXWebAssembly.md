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
| Android | 模拟器中的真实 libpag 4.5.85、红色 PAG 像素、视频 PAG 多时间点绘制及动画推进；PLK110 / Android 16 真机：原生二进制纹理、异步上传后的同步读回、完整视频 PAG 三处进度的已呈现像素对照；Release 约 10 秒采样为 24.80 FPS | 长时间连续源帧、持续 25 FPS 与物理上屏帧率尚未验收；其他机型、编码和系统版本兼容性 |
| iOS | 上述模拟器功能；iPhone 14 Pro / iOS 27.0.1 真机：WebGL1 / 2、着色器查询期间的画面保留、原生二进制纹理、上下文恢复、完整视频 PAG 三处进度的已呈现像素对照；最终实现约 10 秒采样为 24.90 FPS | 长时间连续源帧与物理上屏帧率尚未验收；其他机型、编码和系统版本兼容性 |
| Harmony | Mate 60 Pro / HarmonyOS 6.1.1.120 真机：真实 libpag 4.5.85、48 MiB 扩容、红色 PAG 像素、16×16 RGBA 视频帧、seek / stop / restart / remove、视频 PAG 0% / 50% / 90% 像素与播放推进；2026-10-19 两轮各 180 秒采样为 24.998 / 24.999 FPS，每轮 4500 个源帧连续、时钟重置为 0；正常包功能与页面操作验证通过 | 尚未验证反馈者的畅享 90 Plus，也未测量物理上屏帧率；上述 FPS 为实际完成的 PAG flush |
| Web | 浏览器中的 `.wasm` / `.wasm.br`、JS imports、内存扩容；真实 libpag 4.5.85 的 PAGInit、48 MiB 分配、红色 PAG 像素、视频 PAG 多进度绘制、seek 与动画推进 | 其他浏览器、显卡和编码组合尚需验证；依赖 OffscreenCanvas / Worker WebGL，视频另需 WebCodecs |

原生 Canvas 桥接同步返回 WebGL 查询、资源创建和像素读取结果，等待只发生在逻辑执行线程。Harmony 的 Worker 和 UI 线程通过异步回包保持可运行，并在超时或页面关闭时返回明确错误。接入时须同时更新原生 SDK、Service 和 Render 产物；上述宿主回归不能替代 Harmony 设备验收。

Harmony 发布包开启混淆时，SDK 的 `consumer-rules.txt` 保留动态 API 方法、Worker 消息字段、WebView 代理和 Node-API 导出名称，以及资源加载的 `bridgeId` / `pagePath`。这些名称跨越字符串调用或序列化边界；被改名会导致分包加载失败、Worker 调用异常或启动遮罩不消失。增加此类接口时同时更新保留规则和 `harmony/scripts/bridge-obfuscation.test.mjs`。开启混淆的最终正常包已在上述真机通过 PAG 功能验证。

Harmony 的原生定时器在一次性回调执行时移除登记并释放捕获的 JS 引用，取消或销毁后由 libuv 的关闭回调释放原生内存。回调中取消自身、批量清理和参数保活由 `harmony/scripts/quickjs-timers.test.mjs` 使用真实 QuickJS / libuv 验证，避免 2 ms 视频取帧轮询持续积累已结束的定时器。

示例随包的 libpag 4.5.85 补丁在销毁时先停止取帧轮询，再设置 `isDestroyed`；EOF 保留未消费的尾帧及索引。在当前容器支持异步缓冲区分配、播放器仍在重复播放时，同一解码器提前准备下一轮的真实首帧，播放回卷时再接入这份独立数据。每个读取器最多额外保留一帧、8 MiB；超预算取消预取，按正常 seek 解码，不拒绝本来支持的大帧。暂停后的手动 seek、销毁和迟到回调不会沿用旧预取。重新构建 npm 产物或升级库时需保留补丁或确认上游已修复，并运行 `harmony/scripts/libpag-video-reader.test.mjs` 和 `harmony/scripts/libpag-buffer-pipeline.test.mjs`；这些是示例依赖补丁，不属于原生 SDK 的公开 API。

Service 与 Render 协商私有异步缓冲区能力，预分配始终等待真实 GL 创建结果；公共 `createBuffer()` 仍同步返回，缺少能力的容器保留原路径。异步分配最多为 16 个活动请求准备当前对象，并另保留两个未来空缓冲区，保留真实 `null`，失败不重放创建，取消或上下文变化后释放未使用对象。两个未来对象用于覆盖一次分配反馈延迟，不提前生成视频帧。没有 GL 分配的帧保留最后确认的上下文，避免下一帧退回同步创建。全局播放器所有者只在串行 Wasm 队列内设置和清理；异步准备通过管理器、工厂和读帧器显式传递所有者，防止一个播放器准备或失败时改写另一个挂起的 Wasm 操作。实际编译产物回归覆盖同步创建回退、两个播放器交错及读帧器归属；独立禁用关键机制后均在目标断言失败、恢复后通过。

2026-10-15 使用官方 `video.pag`（720×1080、25 FPS），每轮预热 5 秒、测量 20 秒。播放器销毁修复在两组中均启用，旧原生定时器在两轮结束后仍登记 1944 / 3222 条记录，新实现均为 2 条；新实现中未再出现已销毁 `VideoReader` 的轮询报错。9 项原生定时器回归和 1 项播放器回归通过，原生回归还检查 libuv 句柄、原生分配及捕获的 ArrayBuffer 回收。

这项资源释放修复没有证明播放帧率改善：同一逐帧诊断方法下，旧原生定时器完成帧率为 14.87 / 14.23 FPS，新实现为 12.90 / 13.13 FPS，仍有 547 / 551 ms 长帧。新实现每次同步 Canvas 桥接平均约 44 ms。以上是本轮 Release 诊断包（关闭宿主调试和混淆）的 `PAG.flush` 完成帧率，不能与前一天的轻量采样直接等同，也不能据资源记录恢复正常认定 #352 卡顿已修复。性能测试结束后恢复正常混淆包、原始资源加载逻辑和不含采样脚本的资源。

播放器连续读取常用 WebGL 状态时，Service 将查询合并为一次真实 Render 读回；修改状态、调用扩展、调整画布尺寸或进入下一轮任务后，旧读回结果失效。此优化减少原生线程间同步往返，不使用预设状态替代实际 WebGL 结果。Wasm 仍由解释器执行，实际帧率需要用目标设备和业务素材测量；可在持续播放时读取 `PAGView.getDebugData()` 的 `FPS` 与 `flushTime`，首秒和首次资源加载期间的数据不代表稳定播放性能。

Render 对大块 RGBA 的 RLE 恒定尾部上传合并 Base64 与 RLE 解码，使用固定 8 MiB 的浏览器 Wasm 工作区。输出是独立副本，每次调用后清空工作区；完整校验数据后才上传。缺少 SIMD、TextEncoder 或 Wasm 执行权限时继续使用原 JS 解码器，不改变 `WXWebAssembly` 的原生能力范围。2026-10-14 的同机对照中，关闭此路径出现 515 / 459 ms 长帧，恢复后为 137 / 135 ms；平均完成帧率仍为 19.89 / 19.70 FPS，不能据此认定 #352 的持续播放性能已经达标。

2026-10-15 后续优化保留了两处 Render 解码改动：Base64 主体按 16 字符使用 SIMD 校验与解码，最后一组仍严格检查填充；从 RLE 尾部选择实际需要展开的行数，并在完整解析所有 token、确认真实末尾 run 后才接受该范围。工作区仍固定为 8 MiB，每次调用后清空已使用部分，不保留前一帧像素。回归覆盖全部 256 种输入字节、SIMD 边界与尾部填充、写入边界，以及伪装成 run 的 literal 尾部。移除行数优化后，目标回归在预期展开范围断言失败，恢复后通过。

同一正常原生实现的临时诊断包按旧 / 新 / 新 / 旧顺序各预热 5 秒、测量 20 秒。旧解码器两轮完成帧率为 16.44 / 12.24 FPS，新解码器为 14.00 / 13.55 FPS；不能据此认定端到端帧率改善。按实际解码调用数加权，解码、返回副本与清理的平均耗时由 7.66 ms 降到 6.22 ms，展开范围由每次 3,110,400 字节降到约 2,027,393 字节；此处不是总工作区容量。新实现仍出现 578 / 555 ms 长帧，#352 的持续播放性能尚未达标。

对已完整校验的 RLE 恒定尾部纹理，解码器在复制字面量及读取重复色块时同时检查 alpha。只有已展开前缀及省略尾部均为 alpha 255 时，上传才临时关闭 `UNPACK_PREMULTIPLY_ALPHA_WEBGL`，在 `finally` 中恢复原值；透明像素保留原路径。逐字节结果、所有 SIMD 通道及标量余数、透明尾部和上传异常恢复均有回归。Common 72 项、Render 289 项测试通过；移除上传切换机制时，2 项新增回归因缺少实际 GL 状态切换而失败，恢复后通过。此优化不缓存前一帧像素，也不改变 GL 查询结果。同机正常原生传输、开启混淆的诊断包按开启 / 关闭 / 开启顺序各跑两轮：开启为 12.76 / 12.05 FPS，关闭为 10.72 / 9.39 FPS，再开启为 12.85 / 12.22 FPS；每轮仍预热 5 秒、测量 20 秒，功能与像素检查均通过。不同传输或构建配置的较早结果不与此组直接比较。

后续分阶段真机采样定位到视频末尾的重复解码：原生输入已收到 EOS 时，即使转换队列或驱动输出队列仍持有所需尾帧，前向 seek 也被拒绝，播放器重新解码前一个关键帧组。该轮修复仅在持有目标时间及之后的真实帧时保留前向 seek；空 EOS 和参数数据不算帧，目标已耗尽、向后 seek、控制排队及取消仍走原有流程。相同素材、预热和测量窗口的两轮对照中，视频准备最长耗时由 451 / 424 ms 降为 109 / 81 ms，整帧最长耗时由 584 / 576 ms 降为 219 / 206 ms，完成帧率由 13.55 / 12.71 FPS 变为 14.76 / 14.25 FPS。像素、seek 和生命周期检查通过；48 项原生 seek 回归通过，其中 3 项新增尾帧用例在旧实现上因拒绝有效目标而失败。此结果确认该尾帧停顿已改善，整体持续播放性能仍未达到 25 FPS。

继续排查时确认：输入 EOS 仅表示压缩数据已送完，解码器仍可能在转换或尚未回调的输出中持有尾帧。因此输入结束、输出尚未结束时，前向 seek 继续排空同一解码器；只有输出 EOS 已完成且没有所需的真实帧时才恢复异步 seek。未到达目标就结束时返回真实 EOF，不补帧。51 项 seek 回归及全部 191 项 Harmony 宿主回归通过（含后续播放器 EOF 回归）。解锁后的同机基线复测为 13.80 / 14.21 FPS，三处像素及生命周期检查通过，持续播放仍未达到 25 FPS。

本次还试验了逐包无损 LZ4、通道重排和 zlib 压缩。LZ4 未证明端到端收益，zlib 两轮降到 8.61 / 7.79 FPS。后续通过资源拦截异步交付 Base64 像素包的试验虽通过像素检查，两轮也仅为 7.85 / 7.15 FPS。这些试验均未保留到框架或最终生成资源中。当前资源为 JSSDK 62（1.0.61），恢复正常混淆、正常资源加载与不含采样脚本的应用包；真机功能验证和性能采样仍分别记录。

该浏览器解码内核的 C 源码和生成脚本位于 `fe/packages/common/src/core/canvas-decode-kernel.c` 与 `fe/packages/common/scripts/build-canvas-decode.mjs`。修改 C 源码后，用具备 wasm32 后端的 LLVM clang 与 wasm-ld 重新生成已提交的字节码；普通 Vite 构建不需要这两个工具。

Render 的同步纹理上传可以在完整校验 RLE 数据后直接消费临时解码视图，实际 WebGL 调用结束后立即清空工作区；上传异常也会恢复像素存储状态并清理数据。需要保留数据的解码接口仍返回独立副本。原生视频帧仅在 QuickJS 返回独立持有的 ArrayBuffer 时附带 `dataOwned: true`，播放器据此省去额外复制；旧容器及共享缓冲仍执行防御性复制。这些改动减少复制开销，不代表已经达到持续 25 FPS。

该同步上传改动在正常传输、开启混淆的 Mate 60 Pro 上进行启用／关闭／重新启用对照，各轮预热 5 秒后测量 20 秒：完成 `PAG.flush` 的帧率分别为 18.59／17.39、15.85／14.54、17.52／17.08 FPS，像素和生命周期检查通过。较早的原生二进制端口实验为 23.68／23.69 FPS。两条路径都未达到持续 25 FPS，以上数据也不是物理上屏帧率。

2026-10-16，Harmony 原生二进制通道已加入工作区源码和 SDK 资源 64。通道仅在 Render 明确声明协议能力并完成握手后传输 Canvas 字节；同步查询、异步发布和脚本共用 FIFO。旧前端、缺少系统接口或握手失败时选择原有链路；原生提交开始后发生失败则取消请求，避免回退重放 GPU 操作。真实 Node-API 和 QuickJS 回归覆盖异步字节、JSON 语义、端口地址复用后的迟到回调、队列预算及环境隔离，独立消融均在目标断言处失败、恢复后通过。Common 76 项、Service 859 项、Render 305 项、Harmony 211 项回归及 Release HAP 构建通过。解锁后的 Mate 60 Pro 上，Release 混淆诊断包通过 12 项功能、像素及生命周期检查，每轮预热 5 秒后测量 20 秒，完成 `PAG.flush` 的帧率为 23.42 / 23.66 FPS，仍未达到持续 25 FPS。宿主调试配置与当前示例保持一致；该数据不是物理上屏帧率。

进一步分段采样确认，该素材合成为 25 FPS、10 秒，内嵌视频为 24 FPS、1440×1080 RGBA。播放器视频准备平均约 3.6–4.1 ms；Wasm 刷新平均约 28 ms，其中包含约 4.1 ms 原生编码及约 14.7 ms Canvas 同步查询，不能将这些包含关系重复相加。每帧查询由真实 `createBuffer` 触发。独立查询诊断中，Render 读取和执行约 4.5 ms，原生投递到 Render 约 7.8–8.0 ms，回传约 1.6 ms，条件变量唤醒约 0.3–0.4 ms。改用现有 ArkTS 同步代理回传、提前异步上传纹理及单独调整调度均未证明达到持续 25 FPS，未保留这些候选改动。

Harmony 的 NV12 转换预先计算 256 种亮度和色度输入对应的双精度值，复用约 8 KiB 的只读表，省去逐像素缩放和除法；颜色矩阵的 FMA 顺序、截断及标量路径保持原样。四种色彩配置下的 67,108,864 组 YUV 输入、11,520 种裁剪及对齐组合均与原公式逐字节一致。Mate 60 Pro 上对同一真实解码帧交替运行新旧转换，共比较 1088 帧，完整 RGBA 无字节差异，平均 CPU 时间由 12.34 ms 降到 8.03 ms，减少约 35%。此同帧对照执行了两遍转换，其 FPS 不作为性能验收；只开启查表的独立播放为 23.77 / 23.05 FPS，仍未达到持续 25 FPS。

对于 U/V 均为 128 的中性色度像素，两个颜色矩阵的色度贡献均为零。ARM64 路径使用额外 2 KiB 的 RGBA 亮度表，跳过重复的 FMA 和逐通道转换，其余像素沿用原公式。约 6700 万组 YUV 输入、11520 种布局及 ARM64 FMA 边界回归保持逐字节一致。2026-10-19 在同机同帧交替执行两种转换，961 帧的完整 RGBA 无差异，平均线程 CPU 时间从 10.79 ms 降至 3.94 ms（约 63%）。这是像素转换耗时；独立播放两轮约为 24.95 FPS，每个 20 秒窗口仍有 1 个源帧间隙，持续 25 FPS 尚未验收。

解码模式 1 在解码线程生成可选的 RLE 候选包，与独立持有的 RGBA 缓冲区一同释放并计入 QuickJS 内存预算。Service 复用前逐字节核对原始像素；调用方修改数据后仍重新编码。候选登记最多 32 项，只保留弱引用。实际 QuickJS 回归覆盖像素修改、缓冲区分离和内存计费，分别禁用所有权及计费后均在目标断言失败，恢复后通过。

2026-10-19 已重建正常 JSSDK 65 和示例资源，并在 Mate 60 Pro 验证实际播放、暂停、重置及关闭后重进。上述优化的干净诊断包每轮预热 5 秒、测量 60 秒，完成 `PAG.flush` 的帧率为 24.96 / 24.67 FPS，实际源帧间隙分别为 3 / 20，播放器时钟均未重置。持续 25 FPS 仍未达标；该结果也不代表物理上屏帧率。后续阶段观测显示，多数间隙出现在上一帧处理结束后等待 RAF 回调期间，视频帧等待最多 2 ms，不能仅凭取帧调用的墙钟长耗时认定解码锁阻塞。

原生 Canvas 在同页 Render 明确声明 `animationFrameStream: 1` 后提供私有 RAF 订阅；含视频的 PAG 复用该订阅，由 Render 调用真实浏览器 RAF，省去每帧重新发起请求的串行等待。最多保留 4 个未确认回调，未确认回调达到上限后等待确认并申请新的真实 RAF，不补发旧帧。应用或页面隐藏时取消订阅，恢复后使用新的请求标识过滤迟到回调；暂停、销毁和页面卸载释放订阅。旧 SDK、Web Worker 和纯图形播放继续使用原有一次性 RAF。播放器进度、25 FPS 源时钟和分辨率保持原样。

2026-10-19，该路径的同包开关对照使用相同原生库及 SDK，各轮预热 5 秒、测量 60 秒：开启为 24.97 / 24.97 FPS，源帧间隙 2 / 2；关闭为 24.83 / 24.87 FPS，源帧间隙 10 / 9。14 项功能、像素及生命周期检查通过，时钟重置均为 0。Service 883 项、Render 311 项及实际编译产物的 55 项播放器回归通过；分别禁用回调预算、可见性保护、旧请求过滤和耗尽后的销毁清理后，对应用例在目标断言失败，恢复后通过。该结果确认调度等待减少，仍未验收持续无源帧间隙的 25 FPS，且不代表物理上屏帧率。正常资源更新为 JSSDK 66，不包含诊断计时入口或采样脚本。

异步 WebGL 缓冲区分配在成功、返回 null 与失败后，主动解除任务闭包对资源及 Promise 完成函数的捕获。真实 QuickJS 回归每条路径执行 2048 次，确认已完成 Promise 无需等待循环 GC，且释放所有者根后任务闭包不再保留资源。旧实现及分别撤销资源、拒绝函数清理的实现均在目标断言失败，恢复后通过；实际压缩后的 Service 方法也通过相同检查。该修复不增加 GL 调用或跨线程消息，不改变运行时 GC 策略。正常资源更新为 JSSDK 67。

同机同原生库、Render 和播放器的两轮 60 秒对照中，引用清理开启为 24.97 / 24.98 FPS，源帧间隙 2 / 1；关闭为 24.98 / 24.97 FPS，源帧间隙 1 / 3。两组 14 项功能、像素及生命周期检查通过，时钟均未重置。该结果确认修复没有引入明显退化，尚不能证明持续帧率提高或持续无间隙的 25 FPS 已达标。

JSSDK 68 继续释放已完成分配任务中的回调循环引用。Render 根据实际 WebGL1 绑定及 VAO 引用确认缓冲区已删除且不再被 GPU 容器引用后，通过已有反馈附带释放确认，每次最多 128 条。Service 此时将代理移入弱引用索引，增量清理已回收的记录；调用方仍持有的对象保留身份、自定义属性及删除后的 GL 错误语义。非当前 VAO 持有的缓冲区继续强引用；缺少 WeakRef、绑定关系不明确或使用呈现上下文时保留原有路径。示例 libpag 的生成式异步调度辅助函数也在完成或失败时解除回调循环引用，不改变 Promise、源时钟或播放进度。

同机两轮 60 秒对照中，引用回收开启为 25.00 / 24.97 FPS，源帧间隙 0 / 2；关闭为 24.95 / 24.91 FPS，源帧间隙 3 / 5。开启后每轮末尾的弱引用记录均为 1 条，关闭后已删除缓冲区的强引用继续每分钟增长约 1500 条。15 项真机功能、像素及 VAO 检查通过，时钟重置为 0；Service 896 项、Render 321 项、Container SDK 387 项、真实 QuickJS 生命周期 6 项及实际编译产物的 55 项播放器回归通过。关键释放、VAO、反馈预算、弱引用和迟到回调保护分别撤销后，目标断言失败，恢复后通过。该结果确认引用累积已改善，持续无源帧间隙的 25 FPS 仍未验收。

原生取帧转换先接管像素缓冲区，再创建结果对象。QuickJS 在计算自动回收预算时计入即将接管的容量，避免创建缓冲区对象时立即重复回收；失败时恢复原有预算及其配置方式，释放容量后仅按现有公式收紧自动预算，保留显式设置的 GC 阈值。内存上限、容量记账及失败后由调用方保有数据的约定保持不变。强制触发回收的真实整帧转换回归由 3 次 GC 降为 1 次；Release / Debug 回归覆盖 33 个分配边界、显式阈值及禁用自动 GC、失败和成功释放后的循环对象回收，另验证缓冲区转移、像素、生命周期和 JSON 兼容性，共 11 项原生回归通过。分别撤销结果对象的创建顺序和显式配置的失败回滚后，对应 GC 次数断言失败，恢复后通过。

同一 SDK 68、相同播放器的两轮 60 秒真机对照中，该原生优化开启为 24.98 / 25.00 FPS，源帧间隙 1 / 0；关闭为 24.98 / 25.00 FPS，源帧间隙 2 / 0。两组 15 项功能、像素及 VAO 检查通过，时钟重置为 0。该结果与宿主回归共同证明重复回收工作减少，但仅凭这组较小的帧率差异不能认定持续播放问题已完全解决。

JSSDK 69 在 Harmony 增加私有硬件帧订阅，由 `OH_NativeVSync` 的真实回调驱动含视频 PAG；公开 `requestAnimationFrame()` 仍使用浏览器时钟。每个订阅最多有四个未确认回调，暂停、隐藏和销毁会取消订阅，迟到回调受订阅代次及所有者存活状态保护。其他平台或原生能力不可用时保留浏览器路径；播放器的 `Date.now()` 源时钟、25 Hz 素材进度和 WebGL 结果保持不变。真实 QuickJS 在释放临时像素容量后保留已经学到的自动回收预算，同时为硬内存上限保留一半剩余空间，显式设置的阈值仍优先。

2026-10-19 使用同机官方 `video.pag`（720×1080、25 FPS），保留正常页面每 250 ms 的进度更新，每轮预热 5 秒、连续测量 180 秒。两轮实际完成帧率为 24.997778 / 24.998889 FPS，每轮完成 4500 个连续源帧、没有源帧跳号，时钟重置为 0。该结果是运行时完成帧率；未测量物理上屏帧率。移除临时原生计数接口及分段采样钩子后的正常混淆包通过像素与功能检查，以及实际播放、暂停、重置、后台返回、继续播放、关闭和重新打开操作；关闭重开验证的是保留页面。Service 902 项、原生桥接与播放器 87 项、实际正常编译产物 67 项回归及 QuickJS Release / Debug 内存预算回归通过。硬件回调的投递、背压、旧代次过滤、停止，以及双缓冲的创建、转移和释放分别消融后，目标断言失败，恢复后通过。

最终正常包与采样包的原生库及 JSSDK 69 逐字节一致，采样应用仅保留正常页面进度更新与实际完成计数，并在测量结束后显示结果，不含原生诊断计数接口。两轮各 60 秒复验为 25.000000 / 24.995834 FPS，每轮完成 1500 个连续源帧、没有源帧跳号或时钟重置，14 项功能检查通过。正常应用资源版本为 10072，不含采样模块。

## Android / iOS Canvas 传输

JSSDK 资源 73 与配套原生 SDK 将 Harmony 的 `rle32-v1` 编码器移到 `native/canvas` 共用。只在 Render 声明编码能力后使用 RLE，并在节省至少 25% 时采用；不可压缩数据保留全部原始字节。Android 使用经过握手的 WebMessage ArrayBuffer 端口，iOS 使用页面独占、只消费一次的本地二进制资源；像素不再嵌入 JavaScript 或 Base64 字符串。iOS 使用该资源通道是因为公开的 [WKWebView 异步脚本参数](https://developer.apple.com/documentation/webkit/wkwebview/callasyncjavascript(_:arguments:in:in:completionhandler:))不接受 Data。Android 按 [WebMessageCompat 的能力检查要求](https://developer.android.com/reference/androidx/webkit/WebMessageCompat)探测 ArrayBuffer 支持。

脚本、异步纹理上传和后续查询保持 FIFO。查询仍返回真实 WebGL 结果，等待只发生在 Service 线程；UI 线程继续处理 WebView 和回包。异步上传窗口达到 32 项或 8 MiB 时，Service 等待执行确认再继续提交；总预算仍为 256 项及 64 MiB。页面关闭或复用会释放待处理数据并过滤旧代次；已提交的二进制操作出错后返回错误，不回退重放。旧 Render、缺少系统能力或握手失败时保留原有通道。Android 还要求 Render 明确声明确认回包能力，防止旧版通道因缺少确认而超时。Android / iOS 的帧订阅仍由浏览器 RAF 驱动。

iOS 本地资源接收器只对同步查询检查提交时的截止时间。已接收的异步发布按 FIFO 执行，其单次执行超时由原生通道在出队时开始计时；排队时间超过 4.5 秒不会使发布过期并关闭整个通道。资源归属、一次性读取、页面代次及队列预算检查继续生效。JSSDK 74 修复了旧接收器误把查询截止时间用于异步发布的问题；iPhone 14 Pro / iOS 27.0.1 的回归为每次资源交付注入 250 ms 延迟，连续提交 24 次上传后检查实际上屏像素及后续查询。相同用例在修复前因通道失效失败，修复后通过。该结果证明慢队列缺陷已修复，尚不能替代 #358 用户工程的白屏复验。

2026-10-19 使用随包真实 libpag 4.5.85 与官方 `video.pag`（720×1080、25 FPS），每组预热 2 秒、测量约 10 秒。对照在相同视频解码优化及播放器上关闭 `encodeCanvasArrayBuffer`，其余实现保持一致，因此该数据衡量纹理编码与交付路径的收益，不是两个发布版本的整体对比。iPhone 14 Pro / iOS 27.0.1 的 Release 优化测试包关闭诊断日志，最终对照为 1.35 → 24.90 FPS。PLK110 / Android 16 的两轮 Release 对照为 2.49 → 24.80、2.30 → 24.80 FPS；此前 Debug 测试包的三轮对照为 1.51 → 6.90、1.50 → 7.50、1.56 → 7.80 FPS，不能用来代表 Release 性能。两端每轮三处进度的已呈现画布像素哈希均与各自对照一致，且有非透明内容，另保留了 iPhone 真机画面截图。上述帧率是成功完成的 `PAG.flush`，尚未验证长期连续源帧、持续 25 FPS 或物理上屏帧率。

后续将 Android 的 YUV→RGBA 像素计算移入原生库，保留 `android:debuggable=true` 和 WebView 调试。PLK110 / Android 16 的两轮 Debug PAG 采样为 25.05 / 25.00 FPS，三处进度像素与旧路径一致；详细对照和边界检查见[视频解码的 Debug 优化](./VideoDecoder.md#android-debug-像素转换)。上述早期 Debug 帧率属于保留 Kotlin 像素计算的版本。

Service 902 项、Render 332 项、共用原生编码及序列化 17 项、Android Debug / Release 各 359 项单元测试及各 6 项真机测试、iOS 所选原生及 WebGL 回归、iOS 独立包资源检查通过，共用编码器通过 Address Sanitizer。真机回归覆盖可压缩及不可压缩纹理、提交后修改源数据、异步上传后的大块及小块读回、WebGL1 / 2、上下文恢复及页面资源归属。两端延迟交付后连续提交 512 次上传的用例在加入背压前均因队列预算耗尽失败，修复后通过。Android 禁用二进制载荷选择后，同一用例在 `binary` 断言失败，像素仍正确；iOS 为资源交付增加可控延迟并禁用 FIFO 后，在 `ordered` 断言失败，恢复 FIFO 后通过。Android 还修复了 JNI 将未提供的对象字段转换为 null 的问题：保留 JSON 的缺省字段语义，数组中的空值和显式 null 保持原样；否则默认文件读取会变成文本或零字节，导致 PAG 加载失败。真实 JNI 用例在旧实现的缺省字段断言处失败，修复后通过。

## Web Canvas 与视频

Web 的 `<canvas type="webgl">` 节点通过 OffscreenCanvas 将绘制权交给逻辑 Worker，WebGL 查询、资源创建和像素读取由浏览器同步执行。通过 `createSelectorQuery().fields({ node: true })` 获取节点；传递在 selector 回调之前完成，同一节点重复查询返回同一对象。页面卸载释放 Worker 的 Canvas 和视频解码资源。`wx.createOffscreenCanvas` 在支持该能力的 Web Worker 中也使用浏览器画布。

含视频的 PAG 使用 WebCodecs 解码 MP4；需要 HTTPS 或 localhost 安全上下文，以及浏览器支持对应编码。`wx.canIUse('createVideoDecoder')` 检查接口是否存在，具体视频的编码支持在 `start()` 时检查。libpag 同步写出的 MP4 保存在当前 Worker 的运行时文件空间，随后异步读取和解码；这些文件随小程序关闭消失，不会持久化到 OPFS。详见[文件系统的 Web 范围](./FileSystemManager.md#web-运行时文件)。
