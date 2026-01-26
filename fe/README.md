# 星河小程序前端框架

## 项目结构

本项目由多个包组成：

- **common**：各分包通用公共工具函数。
- **compiler**：小程序源码编译工具。
- **components**：内置小程序标准组件。
- **container**：原生容器层，为小程序提供 API。
- **jdimina**：webview sdk，为 webview 组件提供调用协议。
- **render**：渲染层，负责 UI 展示与消息处理。
- **server**：网络请求代理服务器, 提供给 web 端网络请求代理，用以解决跨域问题。
- **service**：逻辑层（JavaScript 运行时、worker 线程、消息通道）。

## 环境要求

建议使用 Node 18+, pnpm 8+。

## 开始上手

### 安装说明

```sh
# 安装依赖
pnpm install
```

### 开发说明

```sh
# 编译 example/ 目录下的所有小程序
pnpm compile

# 构建（开发环境，不压缩）
pnpm build:dev

# 构建（生产环境，压缩）
pnpm build

# 预览生产构建
pnpm preview

# Web开发
pnpm dev

# 原生容器调试
pnpm dev:native

# 运行测试
pnpm test

# 生成小程序包
# 注意：需要 shared/jsapp 目录存在
pnpm generate:app

# 兼容windows环境生成小程序到shared/jsapp
pnpm generate:app1

# 生成SDK包
# 注意：需要先执行构建命令
pnpm generate:sdk
```

### 资源生成工具

#### pnpm generate:app

将编译好的小程序打包并复制到共享目录 `shared/jsapp` 中。

**注意事项：**
- 运行前必须确保 `shared/jsapp` 目录已存在，否则命令将终止
- 会自动递增小程序的版本号
- 生成的资源包括 `config.json` 配置文件和 `[appId].zip` 代码包

#### pnpm generate:sdk

将构建好的 SDK 打包并复制到共享目录 `shared/jssdk` 中。

**注意事项：**
- 运行前必须先执行构建命令 `pnpm build` 或 `pnpm build:dev`
- 会自动递增 SDK 的版本号
- 生成的资源包括 `config.json` 配置文件和 `main.zip` SDK 包

### dmcc 编译工具

请参考[编译工具使用说明](./packages/compiler/README.md)。



## 编译导出sdk
pnpm build:dev
pnpm generate:sdk
