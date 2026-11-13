# Dimina.Desktop

在 .NET 客户端中以独立窗口打开 Dimina 小程序，适用于 WPF、WinForms 和其他兼容 .NET Standard 2.0 的宿主。

```csharp
using Dimina.Desktop;

var dimina = await DiminaDesktop.StartAsync(new DesktopOptions {
    RuntimePath = runtimePath,
    PackagesDir = packagesDir,
    DataDir = dataDir,
});
var window = await dimina.OpenAppAsync(new OpenAppOptions { AppId = "your-app-id" });
// 客户端退出时：await dimina.DisposeAsync();
```

调用库不包含原生运行时。请从同版本 GitHub Release 下载目标平台的完整 SDK 包，将运行时和小程序编译产物随客户端分发。

完整配置、原生能力、平台依赖和生命周期说明见 [SDK 接入文档](https://github.com/didi/dimina/blob/main/desktop/sdk/README.md)。
