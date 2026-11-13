# 原生 API 接入

桌面端沿用移动 SDK 的 `wx` API 名称、参数和结果结构。内置网络、剪贴板、文件选择和存储继续走运行时实现；宿主可以注册移动 SDK 已有 API 的原生处理器，例如 `getNetworkType`、`scanCode`、`getSetting`。

注册名称按 [公共 API 参考](../../docs/API-Reference.md#api-列表) 中 Android / iOS / Harmony 已提供的入口校验，不会增加任意顶层 `wx` 方法。实际可用能力由桌面运行时与宿主提供的实现决定。

## 内置桌面能力

以下能力随完整运行时提供，无需宿主逐个注册：

| 能力 | API 与边界 |
| --- | --- |
| HTTP、存储、剪贴板、文件选择 | `request`、存储同步/异步 API、`setClipboardData` / `getClipboardData`、`chooseMessageFile` |
| 上传 / 下载 | `uploadFile`（进度、响应头、abort）、`downloadFile`；上传文件必须来自当前窗口的文件选择或下载结果，下载暂不接受目标 `filePath` |
| TCP | `createTCPSocket`；connect、write、close、on/offConnect / Message / Error / Close，支持 ArrayBuffer |
| UDP | `createUDPSocket`；bind 同步返回本地端口，connect、send / write、setTTL、close、on/offListening / Message / Error / Close；支持二进制、广播及 offset / length |
| 扫码 | `scanCode`；独立窗口打开系统相机，也可从图片识别；支持 scanType、onlyFromCamera、关闭取消 |
| BLE | 适配器开关与状态、发现设备、连接、服务与特征查询、读写、通知订阅、RSSI / MTU 查询及相关 on/off 事件 |
| 网络状态 | `getNetworkType`；有活动网络接口时返回 unknown，无活动接口时返回 none，不推测 Wi-Fi / 蜂窝类型 |

BLE 使用 macOS CoreBluetooth、Windows WinRT 或 Linux BlueZ；源码构建会编译 Rust 辅助程序，SDK 分发包已包含它。macOS 相机、蓝牙及本地网络权限说明写在运行时 app 的 Info.plist，系统首次使用时可能请求授权；修改运行时包后应重新签名。Windows 需允许桌面应用使用相机，Linux 需可用的系统 D-Bus / BlueZ 及相机设备权限。

BLE 测试目标必须广播可连接的 GATT 服务；系统蓝牙可见状态不能代替 BLE 广播。桌面支持 central 模式，MTU 由系统自动协商；macOS 的查询值基于系统允许的单次写入长度，业务可按返回值减 3 控制单包长度。不提供经典蓝牙、外设模式或主动 setBLEMTU。Android 专用 bindWifi 和 mDNS 服务发现未内置。WebSocket 沿用 WebView 的 connectSocket / SocketTask，浏览器对自定义握手头的限制仍然存在。

TCP / UDP 每窗口最多 64 个活动 socket；每窗口累计最多创建 4096 个 socket 标识。文件传输上限 256 MiB，HTTP 上传响应上限 32 MiB；传输超时默认 60 秒，可通过 timeout 设置为 1–300000 毫秒。TCP 连接超时默认 10 秒。运行时关闭窗口时取消在途传输，关闭 socket、BLE 连接与通知，删除下载临时文件，并忽略迟到的事件。

`wx.canIUse` 可查询上述原生入口。宿主仍可注册允许的一次性移动 API 来覆盖内置异步实现；同步方法、对象方法和持续事件由运行时管理。

## 小程序调用

调用方式与移动端相同：

```js
wx.getNetworkType({
  success(result) { console.log(result.networkType) },
  fail(error) { console.error(error.errMsg) },
  complete(result) { /* 成功或失败后调用一次 */ },
})
```

宿主按该 API 的移动端契约返回 JSON 对象，例如 `{ networkType: 'wifi' }`。缺省的 `errMsg` 由容器补齐；已返回的 `errMsg` 会保留，以 `:ok` 结尾时调用 `success`，其他非空结果调用 `fail`，随后将同一结果交给 `complete`。抛出异常或返回失败任务也会进入 `fail`。

以下示例中的 `queryNetworkType` 由宿主网络模块实现，返回移动 SDK 约定的 `networkType` 字符串。

## Node / Electron

在主进程打开小程序前等待注册完成：

```js
import { Dimina } from '@dimina/desktop-sdk'

const dimina = await Dimina.start({ runtimePath, packagesDir, dataDir })
await dimina.registerApi('getNetworkType', async (_params, context) => {
  return { networkType: await queryNetworkType(context.signal) }
}, { appIds: ['your-app-id'], timeoutMs: 30000 })
await dimina.openApp({ appId: 'your-app-id' })
```

处理器第二个参数包含 `appId`、`windowId` 和 `AbortSignal` 类型的 `signal`。异步操作可使用 `signal` 参与取消；窗口关闭、超时或运行时退出后，迟到结果不会回传给已结束的调用。

## Tauri / Rust

原生处理器注册在 Rust 侧，前端仍使用 [Tauri 入口](./tauri/README.md) 打开小程序：

```rust
use serde_json::json;
use tauri_plugin_dimina::{NativeApiOptions, PluginOptions};

let options = PluginOptions::new(runtime_path, packages_dir).api(
    "getNetworkType",
    NativeApiOptions {
        app_ids: vec!["your-app-id".into()],
        timeout_ms: 30000,
    },
    |_params, context| async move {
        let network_type = query_network_type(context).await?;
        Ok(json!({ "networkType": network_type }))
    },
);
// 在已有 Tauri Builder 中注册：.plugin(tauri_plugin_dimina::init(options))
```

宿主需直接声明示例使用的 `serde_json = "1"`。处理器运行于异步执行器，返回 `Err(String)` 会触发小程序 `fail`。取消时会丢弃处理器 future，`context.is_cancelled()` / `context.cancelled().await` 可用于取消协作。需要 `AppHandle` 或 UI 线程时，在宿主 `setup` 中构造并注册插件，通过闭包捕获 handle，并使用 Tauri 的主线程调度方法。

独立使用 Rust 客户端时，可在 `Dimina::start(&options).await?` 后调用 `register_api(name, options, handler).await?`。

## Qt

在 `started` 后注册，收到 `nativeApiRegistered` 后打开小程序：

```cpp
connect(desktop, &Dimina::Desktop::started, this, [desktop] {
    desktop->registerApi("getNetworkType",
        [](const QJsonObject &, const Dimina::NativeApiContext &context,
           Dimina::NativeReply reply) {
            reply({{"networkType", queryNetworkType()}}, {});
        }, {"your-app-id"});
});
connect(desktop, &Dimina::Desktop::nativeApiRegistered, this,
        [desktop](const QString &name) {
    if (name == "getNetworkType") desktop->openApp("your-app-id");
});
```

处理器在 `Desktop` 对象所属线程执行。`reply(result, {})` 成功，`reply({}, error)` 失败；异步完成时可调用 `reply`，SDK 会切回所属线程发送。每次调用只能完成一次。`context` 提供 `appId`、`windowId`、`requestId` 和 `isCancelled()`；`nativeCallCancelled(requestId)` 可用于取消任务。第四个参数为超时毫秒数。

## .NET

使用与移动 API 对应的参数和结果 DTO：

```csharp
using System.Runtime.Serialization;
using System.Threading.Tasks;
using Dimina.Desktop;

await desktop.RegisterApiAsync<NetworkTypeRequest, NetworkTypeResult>("getNetworkType",
    async (request, context) => new NetworkTypeResult {
        NetworkType = await QueryNetworkTypeAsync(context.CancellationToken),
    }, new NativeApiOptions { AppIds = new[] { "your-app-id" } });
await desktop.OpenAppAsync(new OpenAppOptions { AppId = "your-app-id" });

[DataContract]
public class NetworkTypeRequest { }
[DataContract]
public class NetworkTypeResult {
    [DataMember(Name = "networkType")] public string NetworkType { get; set; } = "";
}
```

异常或失败的 Task 会触发小程序 `fail`。`context` 提供 `AppId`、`WindowId` 和 `CancellationToken`。注册时存在 `SynchronizationContext` 时，处理器回到该上下文执行，便于 WPF / WinForms 调用 UI 能力；否则在线程池执行。

## 范围与生命周期

- 在 `openApp` 前完成注册；每次调用都按实际窗口的 appId 校验。授权列表为空或省略时允许当前 SDK 托管的小程序调用；提供列表时只允许列出的 appId。
- 此处理器通道承接移动端已有的一次性异步 API。同步 getter、对象工厂、持续订阅和扩展 Bridge 有各自的移动端协议，不能注册成一次性异步处理器。已有同步存储保持原实现。
- 自定义业务模块沿用移动端的 [第三方扩展 Bridge 协议](../../docs/API-Reference.md#第三方扩展-bridge)。当前独立窗口 SDK 的此通道不提供跨进程扩展模块注册及持续订阅，也不通过新增顶层 `wx` 方法替代。
- 默认超时 30 秒，可配置为 1–300000 毫秒，包含宿主通道的排队和发送时间；参数和结果各限制在 1 MiB 内，最多保留 128 个在途调用。取消会撤销结果回传，已执行的系统操作由宿主自行处理。

原生 API 清单从公共参考生成。更新移动端兼容清单后执行 `node desktop/scripts/sync-mobile-apis.mjs`，桌面构建会检查清单是否同步。更多接入信息见 [桌面 SDK 指南](./README.md)。
