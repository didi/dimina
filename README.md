<p align="right">
  <a href="./README_EN.md">English →</a>
</p>

<p align="center">
  <img src="./assets/readme/hero.svg" width="100%" alt="Dimina 星河小程序：将小程序源码编译并运行在 Android、iOS、Harmony 和 Web">
</p>

<p align="center">
  <a href="https://github.com/didi/dimina/blob/HEAD/LICENSE"><img src="https://img.shields.io/badge/License-Apache%202.0-6E56CF" alt="Apache 2.0 License"></a>
  <a href="#平台运行时"><img src="https://img.shields.io/badge/Platforms-Android%20%7C%20iOS%20%7C%20Harmony%20%7C%20Web-0070F3" alt="Android, iOS, Harmony and Web"></a>
  <a href="https://github.com/didi/dimina/blob/HEAD/CONTRIBUTING.md"><img src="https://img.shields.io/badge/PRs-Welcome-0D9488" alt="Pull requests welcome"></a>
</p>

<p align="center">
  <a href="https://didi.github.io/dimina/"><strong>在线体验</strong></a> ·
  <a href="#最快上手">最快上手</a> ·
  <a href="./docs/API-Reference.md">能力参考</a> ·
  <a href="./CHANGELOG.md">更新日志</a> ·
  <a href="./docs/README.md">架构文档</a> ·
  <a href="#参与共建">参与共建</a>
</p>

Dimina（星河小程序）是滴滴开源的跨端小程序框架：把 WXML、WXSS、JavaScript / TypeScript 小程序源码编译成统一运行时资源包，再由 Android、iOS、Harmony 和 Web 容器加载。既可以把现有小程序作为独立模块嵌入 App，也可以直接使用小程序语法开发跨端页面。

## 同一份小程序，三端真实运行

下面是仓库内同一套“官方组件展示”示例在三个原生平台上的实际效果。Web 端可以直接打开[在线演示](https://didi.github.io/dimina/)体验。

<table>
  <thead>
    <tr>
      <th align="center">Android</th>
      <th align="center">iOS</th>
      <th align="center">Harmony</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="center"><a href="./static/android.jpg"><img src="./static/android.jpg" width="240" alt="Dimina 官方组件示例运行在 Android"></a></td>
      <td align="center"><a href="./static/ios.jpg"><img src="./static/ios.jpg" width="240" alt="Dimina 官方组件示例运行在 iOS"></a></td>
      <td align="center"><a href="./static/harmony.jpg"><img src="./static/harmony.jpg" width="240" alt="Dimina 官方组件示例运行在 Harmony"></a></td>
    </tr>
  </tbody>
</table>

## 把小程序变成可嵌入的跨端模块

Dimina 不只是一个 Web 预览器。它包含小程序编译器、逻辑层与视图层运行时、标准组件、原生能力桥接，以及 Android、iOS、Harmony 和 Web 容器。

- **资源离线化**：小程序包由宿主提供并落到本地，减少运行时网络依赖。
- **逻辑与视图分离**：业务逻辑运行在独立 JS 引擎或 Worker 中，视图由 WebView / Browser 渲染。
- **统一原生能力**：通过标准 API 与扩展 Bridge 调用宿主能力，无需把平台逻辑散落到业务页面。
- **面向真实容器**：支持页面预热、路由、生命周期、组件与跨线程消息链路。

## 从源码到运行时

<p align="center">
  <img src="./assets/readme/runtime.svg" width="100%" alt="Dimina 将小程序源码经 DMCC 编译为资源包，并通过统一运行时契约运行在四个平台">
</p>

DMCC 负责把小程序源码转换为 Dimina 运行时可以加载的逻辑、视图、样式与配置资源。容器内部通过消息通道连接逻辑层、视图层和原生能力，让同一份小程序语义落到不同平台。

### 平台运行时

| 平台 | 逻辑引擎 | 视图容器 | 接入入口 |
| --- | --- | --- | --- |
| Android | QuickJS | Android WebView | [Android SDK](./android/README.md) |
| iOS | JavaScriptCore | WKWebView | [iOS SDK](./iOS/README.md) |
| Harmony | QuickJS | Harmony WebView | [Harmony SDK](./harmony/dimina/README.md) |
| Web | Web Worker | Browser | [在线演示](https://didi.github.io/dimina/) |

## 最快上手

如果只想先看效果，直接打开[在线演示](https://didi.github.io/dimina/)。要在本地跑起仓库自带的 Web 示例，需要 Node.js 22+ 与 pnpm 7+：

```sh
git clone https://github.com/didi/dimina.git
cd dimina/fe
pnpm install
pnpm compile
pnpm dev
```

`pnpm compile` 会编译 `fe/example/` 下的小程序，`pnpm dev` 会启动 Web 容器与代理服务。更多构建、打包和调试命令见[前端工作区说明](./fe/README.md)。

要把编译后的资源包接入原生应用，请选择对应平台：

- [Android 接入说明](./android/README.md)
- [iOS 接入说明](./iOS/README.md)
- [Harmony 接入说明](./harmony/dimina/README.md)

## 能力、架构与边界

Dimina 正在持续对齐小程序标准与微信小程序主要能力，但尚未覆盖全部 API、组件和特性。评估接入前，请先查看当前能力范围与平台差异。

| 想了解什么 | 文档入口 |
| --- | --- |
| 已支持的组件、API 与平台差异 | [能力参考指南](./docs/API-Reference.md) |
| 编译流程、双线程模型与整体架构 | [技术文档](./docs/README.md) |
| DMCC 安装、命令与编译产物 | [编译器使用说明](./fe/packages/compiler/README.md) |
| 小程序包更新与动态下发职责 | [更新机制说明](./docs/MiniProgram-Update.md) |
| 共享资源如何流向各端示例工程 | [共享资源说明](./shared/README.md) |

## 参与共建

Dimina 遵循[小程序标准化白皮书](https://www.w3.org/TR/mini-app-white-paper/)进行设计，欢迎围绕兼容语义、跨端运行时、组件和原生能力一起完善项目。

- 问题反馈与功能建议： [Issues](https://github.com/didi/dimina/issues)
- 提交代码前： [贡献指南](./CONTRIBUTING.md)

<details open>
  <summary>加入微信交流群</summary>
  <br>
  <img src="./static/wechat.png" alt="Dimina 微信交流群二维码" width="240">
</details>

## 开源协议

Dimina 基于 [Apache License 2.0](./LICENSE) 分发和使用。
