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
| Harmony | Worker / Render 查询协议、包内读取和解码器控制的宿主回归；原生桥接语法检查 | 无模拟器，尚未验证 ArkWeb 绘制、系统解码和完整 API 20 SDK 构建 |
| Web | 浏览器中的 `.wasm` / `.wasm.br`、JS imports、内存扩容；真实 libpag 4.5.85 的 PAGInit、48 MiB 分配、红色 PAG 像素、视频 PAG 多进度绘制、seek 与动画推进 | 其他浏览器、显卡和编码组合尚需验证；依赖 OffscreenCanvas / Worker WebGL，视频另需 WebCodecs |

原生 Canvas 桥接同步返回 WebGL 查询、资源创建和像素读取结果，等待只发生在逻辑执行线程。Harmony 的 Worker 和 UI 线程通过异步回包保持可运行，并在超时或页面关闭时返回明确错误。接入时须同时更新原生 SDK、Service 和 Render 产物；上述宿主回归不能替代 Harmony 设备验收。

Web 的 `<canvas type="webgl">` 节点通过 OffscreenCanvas 将绘制权交给逻辑 Worker，WebGL 查询、资源创建和像素读取由浏览器同步执行。通过 `createSelectorQuery().fields({ node: true })` 获取节点；传递在 selector 回调之前完成，同一节点重复查询返回同一对象。页面卸载释放 Worker 的 Canvas 和视频解码资源。`wx.createOffscreenCanvas` 在支持该能力的 Web Worker 中也使用浏览器画布。

含视频的 PAG 使用 WebCodecs 解码 MP4；需要 HTTPS 或 localhost 安全上下文，以及浏览器支持对应编码。`wx.canIUse('createVideoDecoder')` 检查接口是否存在，具体视频的编码支持在 `start()` 时检查。libpag 同步写出的 MP4 保存在当前 Worker 的运行时文件空间，随后异步读取和解码；这些文件随小程序关闭消失，不会持久化到 OPFS。详见[文件系统的 Web 范围](./FileSystemManager.md#web-运行时文件)。
