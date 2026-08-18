<p align="right">
  <a href="./CONTRIBUTING_EN.md">English →</a>
</p>

# 贡献指南

感谢你有兴趣为 Dimina 做出贡献。我们欢迎提交 Issue、Pull Request，也欢迎参与设计讨论。

## Pull Request

提交 Pull Request 前，请遵循以下指南：

1. 基础分支：请向 `main` 分支提交 Pull Request。
2. 变更范围：每个 Pull Request 应聚焦于一个错误修复、功能或文档变更。
3. 编码风格：请遵循所修改软件包或平台模块的现有代码风格。
4. 提交信息：请使用清晰的英文，并检查拼写。
5. 测试：提交前请运行相关测试或示例构建。

如果变更会影响运行时行为，请提供平台、设备型号、操作系统或 API 版本、相关日志、截图或屏幕录制，以及用于验证的命令。

常用验证命令：

```sh
# 前端软件包
cd fe
pnpm test

# Android 示例与 SDK 模块
cd android
./gradlew build
```

注意：我们默认所有贡献均可依据 [Apache License 2.0](https://github.com/didi/dimina/blob/main/LICENSE) 获得许可。

## Issue

我们欢迎描述清晰的 Issue。

提供以下信息有助于我们更快地解决问题：

- 平台和设备型号
- 操作系统或 API 版本
- Dimina SDK 或编译器版本
- 复现步骤
- 预期行为与实际行为
- 日志、截图或最小复现项目
