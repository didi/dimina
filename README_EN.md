<p align="right">
  <a href="./README.md">中文 →</a>
</p>

<p align="center">
  <img src="./assets/hero-en.svg" width="100%" alt="Dimina compiles mini program source for mobile, Web, and desktop">
</p>

<p align="center">
  <a href="https://github.com/didi/dimina/blob/HEAD/LICENSE"><img src="https://img.shields.io/badge/License-Apache%202.0-6E56CF" alt="Apache 2.0 License"></a>
  <a href="#platform-runtimes"><img src="https://img.shields.io/badge/Platforms-Android%20%7C%20iOS%20%7C%20Harmony%20%7C%20Web%20%7C%20Desktop-0070F3" alt="Android, iOS, Harmony, Web and Desktop"></a>
  <a href="https://github.com/didi/dimina/blob/HEAD/CONTRIBUTING_EN.md"><img src="https://img.shields.io/badge/PRs-Welcome-0D9488" alt="Pull requests welcome"></a>
</p>

<p align="center">
  <a href="https://didi.github.io/dimina/"><strong>Live Demo</strong></a> ·
  <a href="#quick-start">Quick Start</a> ·
  <a href="#desktop-integration">Desktop Integration</a> ·
  <a href="./docs/API-Reference.md">Capability Reference</a> ·
  <a href="./CHANGELOG.md">Changelog</a> ·
  <a href="./docs/README.md">Architecture</a> ·
  <a href="#contributing">Contribute</a>
</p>

Dimina is Didi's open-source framework for running mini programs across platforms. It compiles WXML, WXSS, and JavaScript / TypeScript source into a unified bundle, then loads it through Android, iOS, Harmony, Web, and desktop containers. You can integrate an existing mini program into a mobile app or open it in a standalone desktop window, keeping familiar mini program syntax.

## One mini program, running on three native platforms

The screenshots below show the same “Official Components Showcase” example running on Android, iOS, and Harmony. To try it yourself, open the [live demo](https://didi.github.io/dimina/) in your browser.

<table width="100%">
  <thead>
    <tr>
      <th width="33.33%" align="center">Android</th>
      <th width="33.33%" align="center">iOS</th>
      <th width="33.33%" align="center">Harmony</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td width="33.33%" align="center"><a href="./static/android.jpg"><img src="./static/android.jpg" width="240" alt="Dimina official component example running on Android"></a></td>
      <td width="33.33%" align="center"><a href="./static/ios.jpg"><img src="./static/ios.jpg" width="240" alt="Dimina official component example running on iOS"></a></td>
      <td width="33.33%" align="center"><a href="./static/harmony.jpg"><img src="./static/harmony.jpg" width="240" alt="Dimina official component example running on Harmony"></a></td>
    </tr>
  </tbody>
</table>

## Make a mini program an embeddable cross-platform module

Dimina goes beyond Web preview. It includes a mini program compiler, logic and view runtimes, standard components, native capability bridges, and containers for mobile, Web, and desktop. Existing mini programs can be embedded in mobile apps or opened in standalone windows from Electron, Tauri, Qt, and .NET clients.

- **Offline-ready bundles**: The host provides and stores mini program packages locally, reducing runtime network dependencies.
- **Separate logic and view runtimes**: Business logic runs in a dedicated JS engine or Worker while WebView / Browser renders the view.
- **One path to native capabilities**: Standard APIs and extension bridges connect to the host without spreading platform-specific logic across business pages.
- **Runtime-managed page behavior**: The runtime handles preloading, routing, lifecycles, components, and cross-thread messaging.

## One codebase for mobile, Web, and desktop

<p align="center">
  <img src="./assets/runtime-en.svg" width="100%" alt="DMCC compiles mini program source into a runtime bundle loaded by mobile, Web, and desktop containers">
</p>

DMCC converts mini program source into logic, view, style, and configuration resources. Inside each container, a message channel connects the logic layer, view layer, and native capabilities so the same mini program semantics remain consistent across platforms.

### Platform runtimes

| Platform | Logic engine | View container |
| --- | --- | --- |
| Android | QuickJS | Android WebView |
| iOS | JavaScriptCore | WKWebView |
| Harmony | QuickJS | Harmony WebView |
| Web | Web Worker | Browser |
| Desktop (macOS / Windows / Linux) | Web Worker | System WebView (WKWebView / WebView2 / WebKitGTK) |

## Quick start

To see Dimina in action, open the [live demo](https://didi.github.io/dimina/). To run the repository's Web examples locally, have Node.js 22.22.3+ and pnpm 12.2.0+ ready:

```sh
git clone https://github.com/didi/dimina.git
cd dimina/fe
pnpm install
pnpm compile
pnpm dev
```

Here, `pnpm compile` builds the mini programs in `examples/miniprogram/`, and `pnpm dev` starts the Web container and proxy service. See the [frontend workspace guide](./fe/README.md) for more build, packaging, and debugging commands.

When you are ready to integrate a bundle into a native app, start with the guide for your platform:

- [Android integration guide](./android/README.md)
- [iOS integration guide](./iOS/README.md)
- [Harmony integration guide](./harmony/dimina/README.md)
- [Flutter host integration guide](./docs/Flutter-Integration.md)
- [Desktop client integration guide](./docs/Desktop-Integration.md)

## Desktop integration

The desktop runtime targets macOS, Windows, and Linux and loads the same Dimina compilation output. Run the [desktop example](./desktop/README.md), or use the [standalone window SDK](./desktop/sdk/README.md) from an existing Electron, Tauri, Qt, or .NET client.

Build the runtime and language binding following the SDK guide. For Electron's main process / Node.js, use absolute paths for all three directory and executable options:

```js
import { Dimina } from '@dimina/desktop-sdk'

const dimina = await Dimina.start({ runtimePath, packagesDir, dataDir })
await dimina.openApp({ appId: 'your-app-id' })
// When the host exits, call await dimina.dispose() to release the runtime.
```

Built-in capabilities include HTTP requests and file transfers, TCP/UDP, storage, file selection, clipboard, scanning, and BLE, using the mobile SDK's `wx` API names. See [desktop native APIs](./desktop/sdk/Native-APIs.md) for system requirements and supported behavior. Only standalone windows are currently provided; embedding in a host window or panel is not available.

## Capability boundaries and further reading

Dimina continues to align with mini app standards and major WeChat Mini Program capabilities, but it does not yet cover every API, component, or feature. Before adopting it, review the current capability range and platform differences.

| What you need | Documentation |
| --- | --- |
| Supported components, APIs, and platform differences | [Capability reference](./docs/API-Reference.md) |
| Compiler flow, multi-thread model, and architecture | [Technical documentation](./docs/README.md) |
| DMCC installation, commands, and output | [Compiler guide](./fe/packages/compiler/README.md) |
| Standalone mini program windows in Electron / Tauri / Qt / .NET | [Desktop SDK integration](./desktop/sdk/README.md) |
| Package updates and dynamic delivery responsibilities | [Update mechanism](./docs/MiniProgram-Update.md) |
| How shared resources flow into platform examples | [Shared resources](./shared/README.md) |

## Contributing

Dimina's architecture is informed by the [Mini App Standard White Paper](https://www.w3.org/TR/mini-app-white-paper/) and grows by working through real cross-platform differences one by one. Moonlight scatters across a river of stars, and the road ahead stretches on, one patient step at a time. If you care about compatibility semantics, cross-platform runtimes, component behavior, or native capabilities, open an issue or add a line of code. We would be glad to walk that road with you.

- Have a problem or an idea? [Open an issue](https://github.com/didi/dimina/issues)
- Ready to contribute code? [Read the contribution guidelines](./CONTRIBUTING_EN.md)

<details open>
  <summary>Come say hello in our WeChat group</summary>
  <br>
  <img src="./static/wechat.png" alt="QR code for the Dimina WeChat community" width="240">
</details>

## License

Dimina is open source under the [Apache License 2.0](./LICENSE).
