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

在仓库 **Settings → Secrets and variables → Actions** 添加以下 Repository secrets：

| Secret | 用途 |
| --- | --- |
| `DESKTOP_NPM_TOKEN` | npm granular access token，具有 `@dimina/desktop-sdk` 发布权限，并允许 CI 无交互发布 |
| `DESKTOP_CARGO_REGISTRY_TOKEN` | crates.io API token，具有 `tauri-plugin-dimina` 首次创建或后续更新权限 |
| `DESKTOP_NUGET_API_KEY` | NuGet API key，允许发布 `Dimina.Desktop` 的新包或新版本 |

发布账号须拥有对应包名或作用域。正式发布会先检查三个 Secret 是否齐全；`dry_run` 不需要发布凭据。GitHub Release 使用内置 `GITHUB_TOKEN`，无需额外配置 PAT。

npm 发布生成 provenance，工作流已配置 `id-token: write` 和仓库元数据。Token 不写入源码、制品或日志。凭据有效期和包权限由对应 registry 管理；参考 [npm 发布来源证明](https://docs.npmjs.com/generating-provenance-statements/)、[Cargo 发布说明](https://doc.rust-lang.org/cargo/reference/publishing.html)、[NuGet 发布说明](https://learn.microsoft.com/en-us/nuget/nuget-org/publish-a-package)。

## 发布前验证

将流程配置合入后，在包含该配置的提交上创建发布标签。在 Actions 中手动运行 **Desktop SDK Release**：

- `release_tag`：已有标签，例如 `v2.0.1-beta.1`。
- `dry_run`：保持 `true`。

工作流校验 checkout 与标签一致，执行 Node/Tauri 前端、Rust、BLE helper、Qt、.NET、桌面前端和 Go 检查，并构建六组运行时。全部完成后，`desktop-release` Actions artifact 提供完整制品和校验和，供下载检查。此模式不会创建 GitHub Release，也不会向 registry 上传。

## 正式发布与重试

推送 `v1.2.3` 或 `v1.2.3-beta.1` 格式的标签会由主 Release 流程自动发布桌面 SDK。也可以针对已有标签手动运行 **Desktop SDK Release**，将 `dry_run` 设为 `false`。发布阶段等待所有 SDK 检查和六个平台构建通过；先上传 GitHub Release 附件，再发布各 registry 的调用库。

稳定版本使用 npm 的 `latest` 标签；预发布版本使用 `next`，GitHub Release 同时标记为 prerelease。标签不接受 SemVer build metadata（`+...`），以避免不同 registry 的版本规范化产生歧义。

重试时优先使用 **Re-run failed jobs**，复用本次已经验证的构建产物。已有 GitHub 附件、npm 包或 Cargo 包只有在校验和相同时才跳过；内容冲突会失败，不会覆盖。NuGet 使用 `--skip-duplicate` 跳过已发布的版本。完整重跑会重新构建运行时，压缩包可能因构建时间等信息产生不同校验和；需要更改已发布内容时，应使用新版本。

各 registry 独立发布，无法跨服务原子提交；部分发布失败后，可补跑对应失败任务。制品校验和只覆盖桌面附件，不替换其他平台已有的校验文件。

## 集成产品签名

这些运行时用于集成到现有客户端，不是独立客户端安装器。CI 默认使用桌面构建工具的 ad hoc macOS 签名；不配置 Developer ID、公证凭据或 Windows 代码签名证书。接入产品仍需按自身分发方式完成运行时签名、公证及系统依赖准备，见 [SDK 产品分发说明](../desktop/sdk/README.md#发布到已有产品)。
