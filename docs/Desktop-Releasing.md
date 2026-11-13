# 桌面 SDK 发布

桌面 SDK 随仓库的 `v*` 标签发布，由 [Release 工作流](../.github/workflows/release.yml) 调用 [Desktop SDK Release](../.github/workflows/desktop-release.yml)。调用库与原生运行时使用同一版本；CI 从标签提取版本，在构建目录中更新清单，不需要逐个修改桌面包的开发版本。

## 发布内容

| 渠道 | 制品 |
| --- | --- |
| npm | `@dimina/desktop-sdk`，包含 Node/Electron 入口和 Tauri 前端入口 |
| crates.io | `tauri-plugin-dimina` |
| NuGet | `Dimina.Desktop` |
| GitHub Release | 各平台完整 SDK 包、上述调用库制品及 `SHA256SUMS-desktop.txt` |

运行时在目标系统原生构建，覆盖 macOS、Windows、Linux 的 x64 和 ARM64。GitHub Release 中的 SDK 包命名为 `dimina-desktop-sdk-{version}-{os}-{arch}.tar.gz`，Windows 使用 `.zip`；架构名称为 `amd64` 或 `arm64`。

每个 SDK 包包含 `runtime/`、Node 调用库、Qt CMake 源码、.NET 项目、Tauri 插件和许可证。macOS 压缩包保留完整 `.app`、符号链接和可执行权限；Windows/Linux 按运行时的安装文件清单收集依赖，避免把中间安装包重复打进去。`version.json` 记录版本与目标平台。

## 首次配置

各 registry 的发布账号须拥有对应包名或作用域，并在仓库 **Settings → Secrets and variables → Actions** 中配置仓库级发布凭据。具体配置项见 [Desktop SDK Release 工作流](../.github/workflows/desktop-release.yml) 中的各发布任务。

测试、构建、打包及 GitHub Release 附件发布不依赖 registry 凭据。npm、crates.io、NuGet 在各自发布任务中独立检查凭据：缺少凭据的渠道会明确失败，不影响其他渠道和 GitHub 附件，也不会被标记为已发布。`dry_run` 不执行 registry 发布任务；GitHub Release 使用工作流内置授权，无需额外配置个人访问令牌。

npm 发布生成 provenance，工作流已配置 `id-token: write` 和仓库元数据。Token 不写入源码、制品或日志。凭据有效期和包权限由对应 registry 管理；参考 [npm 发布来源证明](https://docs.npmjs.com/generating-provenance-statements/)、[Cargo 发布说明](https://doc.rust-lang.org/cargo/reference/publishing.html)、[NuGet 发布说明](https://learn.microsoft.com/en-us/nuget/nuget-org/publish-a-package)。

## 发布前验证

日常分支推送和 PR 会触发 [Desktop Tests](../.github/workflows/desktop-tests.yml)，也可在 Actions 中手动运行。它在 Windows 2025 x64、Ubuntu 24.04 x64、macOS 15 ARM64 上分别执行，无需发布凭据。正式发布复用同一测试流程，全部通过后才会上传制品。

| 范围 | CI 执行内容 |
| --- | --- |
| Go 运行时 | HTTP/文件传输、TCP/UDP 回环连接、文件授权、存储持久化、原生桥接身份与取消；macOS/Linux 启用 race 检查 |
| 前端 | 公共列表、Web 容器、桌面适配与 API 注册回归 |
| Node / Electron、Tauri | 使用原生测试进程验证握手、标准输入输出通信、错误、取消、关闭超时及子进程回收；Node 类型检查 |
| Qt / .NET | 各系统原生编译并执行 SDK 进程生命周期用例；Qt 使用 Qt 6 |
| BLE helper | 状态转换、取消、超时和通知协议的单元测试 |

Node 和 Rust SDK 用例共用可跨平台编译的测试运行时，Windows 不再跳过这些进程协议测试。测试运行时不创建 WebView 窗口，不代替真实桌面运行时的界面验收。相机扫描、真实 BLE 连接、系统权限弹窗、窗口视觉和焦点行为仍需目标设备或具备相应硬件的 runner 验证。三系统测试日志保存在 `test-results-desktop-*` Actions artifacts；发布运行时的 x64/ARM64 构建矩阵保持不变。

将流程配置合入后，在包含该配置的提交上创建发布标签。在 Actions 中手动运行 **Desktop SDK Release**：

- `release_tag`：已有标签，例如 `v1.9.0-beta.1`。
- `dry_run`：保持 `true`。

工作流校验 checkout 与标签一致，执行 Node/Tauri 前端、Rust、BLE helper、Qt、.NET、桌面前端和 Go 检查，并构建六组运行时。全部完成后，`desktop-release` Actions artifact 提供完整制品和校验和，供下载检查。此模式不会创建 GitHub Release，也不会向 registry 上传。

## 正式发布与重试

推送 `v1.2.3` 或 `v1.2.3-beta.1` 格式的标签会由主 Release 流程自动发布桌面 SDK。也可以针对已有标签手动运行 **Desktop SDK Release**，将 `dry_run` 设为 `false`。发布阶段等待所有 SDK 检查和六个平台构建通过；先上传 GitHub Release 附件，再分别发布各 registry 的调用库。完整发布需所有渠道成功；只有附件成功时，仍可下载 SDK 包中的调用库进行接入。

稳定版本使用 npm 的 `latest` 标签；预发布版本使用 `next`，GitHub Release 同时标记为 prerelease。标签不接受 SemVer build metadata（`+...`），以避免不同 registry 的版本规范化产生歧义。

重试时优先使用 **Re-run failed jobs**，复用本次已经验证的构建产物。已有 GitHub 附件、npm 包或 Cargo 包只有在校验和相同时才跳过；内容冲突会失败，不会覆盖。NuGet 使用 `--skip-duplicate` 跳过已发布的版本。完整重跑会重新构建运行时，压缩包可能因构建时间等信息产生不同校验和；需要更改已发布内容时，应使用新版本。

补齐凭据后，可重跑对应的失败任务。若修改了工作流本身，应从包含该修改的分支手动启动 **Desktop SDK Release**，指定已有的 `release_tag`；旧运行的重试仍使用原工作流版本。

各 registry 独立发布，无法跨服务原子提交；部分发布失败后，可补跑对应失败任务。制品校验和只覆盖桌面附件，不替换其他平台已有的校验文件。

## 集成产品签名

这些运行时用于集成到现有客户端，不是独立客户端安装器。CI 默认使用桌面构建工具的 ad hoc macOS 签名；不配置 Developer ID、公证凭据或 Windows 代码签名证书。接入产品仍需按自身分发方式完成运行时签名、公证及系统依赖准备，见 [SDK 产品分发说明](../desktop/sdk/README.md#发布到已有产品)。
