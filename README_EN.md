<p align="right">
  <a href="./README.md">
    <img src="https://img.shields.io/badge/README-中文版%20⤴-26A69A.svg" alt="中文版" />
  </a>
</p>

<div align="center">

![Dimina](./static/logo.png)

[![Dimina is released under the Apache 2.0 license.](https://img.shields.io/badge/License-Apache%202.0-blue)](https://github.com/didi/dimina/blob/HEAD/LICENSE)
[![Platform](https://img.shields.io/badge/Platform-%20Android%20%7C%20iOS%20%7C%20Harmony%20%7C%20Web-4CAF50)](#showcase)
[![PRs welcome!](https://img.shields.io/badge/PRs-Welcome-FF6F61)](https://github.com/didi/dimina/blob/HEAD/CONTRIBUTING.md)

# Dimina - Didi's Open Source Cross-Platform Mini Program Framework

> Dimina is pronounced /diːminə/, short for didi miniprogram. It is designed to provide a flexible and lightweight cross-platform mini program framework.

[Introduction](#introduction) • [Showcase](#showcase) • [Getting Started](#getting-started) • [Contributing](#contributing) • [Star Trend](#star-trend) • [License](#license)

</div>

## Introduction

Dimina is a lightweight cross-platform mini program framework independently developed by Didi. It aims to offer developers a high-performance, cross-platform, and low-barrier development experience.

Currently, Dimina supports four major platforms: Android, iOS, Harmony, and Web. Developers can use Dimina as a **mobile cross-platform framework**—either integrating existing mini program logic as independent modules into current apps, or developing new features using mini program syntax and packaging them into standalone native apps.

### 🔧 Technical Features

- **Offline Resource Caching**: Resources are cached locally to reduce network requests
- **Logic-View Separation**: Independent JS engine prevents main thread blocking
- **Native Capability Encapsulation**: Unified API for native functionality
- **Page Preloading**: WebView preheating for better performance

### 🚀 Cross-Platform Support

- **Android**: QuickJS + Android WebView
- **iOS**: JavaScriptCore + WKWebView
- **Harmony**: QuickJS + Harmony WebView
- **Web**: Web Worker + Browser

## Showcase

Live Demo: <https://didi.github.io/dimina/>

| Android | iOS | Harmony |
| ---- | ---- | ---- |
| ![Android](./static/android.jpg) | ![iOS](./static/ios.jpg) | ![Harmony](./static/harmony.jpg) |

## Getting Started

```mermaid
graph TD
    A[Create Mini Program Project] --> B[Develop Mini Program Pages]
    B --> C[Write Logic Using Mini Program Syntax]
    C --> D[Compile with DMCC]
    D --> E[Generate Dimina Package]
    E --> F{Target Platform}
    F -->|Android| G[Integrate Android SDK]
    F -->|iOS| H[Integrate iOS SDK]
    F -->|Harmony| I[Integrate Harmony SDK]
    G --> J[Run on Android Device]
    H --> K[Run on iOS Device]
    I --> L[Run on Harmony Device]
```

### Step-by-Step Guide

1. **Create Mini Program Project**
   - Set up a new project using mini program development tools
   - Configure `app.json` and page routing

2. **Develop Mini Program Pages**
   - Create WXML templates
   - Add WXSS styles
   - Write page logic using JavaScript

3. **Compile and Package**
   - Use [DMCC Compiler](./fe/packages/compiler/README.md) to transpile mini program code
   - Package the Dimina application
   - Place the generated package in the corresponding platform directory

4. **Platform Integration**
   - [Android Integration Guide](./android/README.md)
   - [iOS Integration Guide](./iOS/README.md)
   - [Harmony Integration Guide](./harmony/dimina/README.md)

5. **Debugging and Publishing**
   - Debug on real devices with integrated app
   - Publish to respective app stores

## Contributing

Dimina is designed in accordance with the [Mini App Standard White Paper](https://www.w3.org/TR/mini-app-white-paper/) and has currently aligned with the main functionalities of the WeChat Mini Program.

For currently supported capabilities, see the [Dimina capability reference guide](./docs/API-Reference.md).

Benefiting from the high similarity between Vue3 and Mini Program syntax, the Dimina framework's underlying view rendering is built on Vue. The Dimina framework uses DMCC (./fe/packages/compiler/README.md) to transpile Mini Program syntax into Vue syntax, and based on this, it implements a complete Mini Program standard Vue component system. Ultimately, by implementing a native Mini Program container on the client side, it provides native capabilities while flexibly loading and displaying view pages.

To learn more about the principles of the underlying implementation of frameworks, please refer to the [documentation](./docs/README.md).

As the mini program ecosystem has evolved over the years, Dimina does not yet fully support all **APIs/components/features** of mini programs. Contributions and suggestions are highly welcome!

- Bug reports and new feature requests are filed in [Issues](https://github.com/didi/dimina/issues)
- Discussions and proposals are discussed in [Discussions](https://github.com/didi/dimina/discussions)

## Star Trend

If you find Dimina helpful, please click the ⭐Star button in the upper right to support us and help more people discover this project.

<img src="https://api.star-history.com/svg?repos=didi/dimina&type=Date" style="width: 60%; height: auto;">

## License

Dimina is distributed and used under the [Apache-2.0](https://opensource.org/license/apache-2-0) license. For more details, please see the [LICENSE](LICENSE) file.
