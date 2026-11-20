# 星河小程序编译工具

[![npm version](https://img.shields.io/npm/v/@dimina/compiler.svg?style=flat)](https://www.npmjs.com/package/@dimina/compiler)

## 编译工具

星河小程序编译工具（DMCC）用于将小程序源码编译为星河小程序运行时所需的文件格式。

### 安装

运行环境要求 Node.js 22.22.3 或更高版本。编译器仅发布 ESM 产物。

```sh
npm install @dimina/compiler -g
```

或者在项目中本地安装：

```sh
npm install @dimina/compiler --save-dev
```

### 使用 npx 执行

如果您不想全局安装，也可以使用 npx 直接执行：

```sh
# 使用 npx 执行编译命令
npx @dimina/compiler build [选项]
```

对于项目中已安装的情况，可以在 package.json 的 scripts 中添加：

```json
{
  "scripts": {
    "build": "dmcc build",
    "dev": "dmcc build -w"
  }
}
```

然后通过 npm 执行：

```sh
# 编译项目
npm run build

# 开发模式（监听文件变化）
npm run dev
```

### 使用方法

#### 基本命令

```sh
# 查看版本
dmcc --version

# 编译小程序
dmcc build [选项]
```

#### build 命令选项

```sh
Usage: dmcc build [选项]

选项:
  -c, --work-path <path>     编译文件所在目录（默认为当前目录）
  -s, --target-path <path>   编译产物存放路径（默认为当前目录）
  -w, --watch                启用改动监听（实时编译）
  --sourcemap                生成 logic.js.map，用于原生逻辑层断点调试
  --compatibility-report    生成静态兼容报告，仅支持完整构建
  --no-app-id-dir            产物根目录不包含appId，默认为 false
  -h, --help                 显示帮助信息
```

#### 示例

```sh
# 编译当前目录下的小程序项目
dmcc build

# 编译指定目录的小程序项目，并将产物输出到指定目录
dmcc build -c ./src -s ./dist

# 监听文件变化，实时编译
dmcc build -w

# 完整示例：编译指定目录，输出到指定目录，并启用监听
dmcc build -c ./src -s ./dist -w

# 产物根目录不包含appId
dmcc build --no-app-id-dir

# 生成 Harmony QuickJS 断点调试所需的 source map
dmcc build -c ./miniapp -s ./dist --sourcemap
```

Harmony 端的虚拟脚本路径、VS Code attach 与 HDC 端口转发配置见
[JavaScript 断点调试](../../../docs/JavaScript-Debugging.md)。

### 兼容报告

```sh
dmcc build -c ./miniapp -s ./dist --compatibility-report
```

构建成功后，在产物根目录（默认 `./dist/<appId>/`）生成 `dimina-compatibility-report.json`。
报告列出直接引用的 `wx` API、模板中识别到的基础组件、源码位置和本次构建的 `[compat]` 告警。
`apis[].platforms` 对应[能力参考](../../../docs/API-Reference.md)的 Android、iOS、Harmony 和 Web 列，取值为 `supported`（有实现）、`unavailable`（未提供）或 `unverified`（未确认）。
`platforms: null` 表示清单中没有该 API，应核对宿主是否有注册。
`components[].listed` 表示组件是否列入支持清单，每个仍需在目标平台验证。

静态扫描覆盖 `wx.foo` 和 `wx['foo']` 等直接引用。动态属性名、API 参数、运行时行为和桌面能力需另行核对。
同次构建可加 `--sourcemap`，监听模式 `--watch` 只输出沿用的控制台告警。

### 编译流程说明

编译工具会将小程序源码转换为星河小程序运行时可识别的格式：

```txt
app.js, index.js      ->  logic.js     (逻辑文件)
app.ts, index.ts      ->  logic.js     (TypeScript 逻辑文件)
index.wxml            ->  页面视图模块（写入对应的页面 .js）
app.wxss, index.wxss  ->  app.css / 对应的页面 .css
app.less, index.less  ->  app.css / 对应的页面 .css
app.scss, index.scss  ->  app.css / 对应的页面 .css
app.sass, index.sass  ->  app.css / 对应的页面 .css
app.json, index.json  ->  main/app-config.json（运行时配置）
game.js, game.json    ->  main/logic.js + main/app-config.json（小游戏入口，不生成页面视图/样式）
miniprogram_npm/      ->  组件与依赖编译（npm 组件支持）
```

### CPU 与内存调优

DMCC 默认最多并发两个编译阶段，在编译速度、CPU 峰值和 Worker 内存之间取平衡；
普通 WXSS/DDSS 项目不会加载 Less 或 Sass 运行时。可按 CI 或开发机资源显式调整：

```sh
# 内存紧张或希望降低 CPU 峰值
DIMINA_COMPILER_MAX_WORKERS=1 dmcc build

# 吞吐优先的高配构建机
DIMINA_COMPILER_MAX_WORKERS=3 dmcc build

# 单个 Worker 的 V8 old generation 上限（MiB，默认最多 2048）
DIMINA_COMPILER_WORKER_MEMORY_MB=1024 dmcc build
```

容器环境会读取 cgroup v1/v2 的 CPU、内存限额。以上变量只改变资源预算，
不会改变 logic/view/style 的产物或增量编译语义。

### 微信小游戏入口

当 `project.config.json` 的 `compileType` 为 `game`，或工程只有 `game.json` + `game.js`/`game.ts` 而没有 `app.json` 时，DMCC 会按小游戏编译。产物的 `main/app-config.json` 包含 `app.runtimeType: "game"`、`app.entryPagePath: "game"`，`main/logic.js` 包含 `game.js` 及其本地依赖；不会生成 WXML 页面和页面 CSS。运行能力与边界见[微信小游戏运行文档](../../../docs/Mini-Game.md)。

### TypeScript、Less 和 Sass 支持

- `.ts` 文件由 esbuild 转换为 CommonJS；DMCC 不执行类型检查，也不读取 `tsconfig.json`
- ES module import 支持相对路径、npm 包路径和以 `/` 开头的小程序绝对路径
- `.less` 文件由 Less 编译，`.scss` 和 `.sass` 文件由 Dart Sass 编译
- 样式预处理或 PostCSS 转换失败时构建会报错，不会静默使用原始样式

#### 支持的文件类型

逻辑文件查找顺序：`.js` → `.ts`

样式文件查找顺序：`.wxss` → `.ddss` → `.less` → `.scss` → `.sass`

详细使用说明请参考：[TypeScript、Less 和 SCSS 支持文档](./docs/typescript-less-scss-support.md)

### 自定义文件类型（custom file types）

编译器内置识别 `wx*`（`.wxml/.wxss/.wxs`）与 `dd*`（`.ddml/.ddss`）系扩展名。通过编程入口 `build()` 的 `options.fileTypes`，可在内置之上**追加**自定义品牌扩展名（如 `.qdml/.qdss/.qds`），使其与对应内置类型等价编译：

```js
import build from '@dimina/compiler'

await build(targetPath, workPath, true, {
  fileTypes: {
    template: ['qdml'],   // 追加模板扩展名，与 .wxml/.ddml 等价
    style: ['qdss'],      // 追加样式扩展名，与 .wxss/.ddss 等价
    viewScript: ['qds'],  // 追加 WXS 类视图脚本：同时覆盖 .qds 文件与内联 <qds> 标签
  },
})
```

- 自动归一化：补前导点、转小写、去重；内置项在前、自定义项在后即查找优先级。
- 内置 `wx`/`dd` 系永远保留，仅追加不替换。
- `viewScript` 同时作用于**文件扩展名**（`.qds`）与**内联标签**（`<qds module>`）。
- CLI 暂未开放对应 flag，自定义文件类型能力通过编程入口注入。

### npm 组件支持

编译器会解析已经由开发者工具或 `miniprogram-ci` 生成的 `miniprogram_npm` 目录：

- 从当前目录逐级向工程根目录查找 npm 组件
- 编译组件及其 `usingComponents` 依赖
- 保留相对路径和小程序绝对路径组件引用
- 通过仓库批量编译入口运行时复用持久化编译缓存

#### npm 组件使用示例

```json
// pages/index/index.json
{
  "usingComponents": {
    "lib-button": "lib-weapp/button",
    "custom-component": "./components/custom"
  }
}
```

详细使用说明请参考：[npm 支持文档](./docs/npm-support.md)

### 编译产物目录结构

编译后，默认会在目标目录生成以小程序 ID 命名的目录。主包资源位于固定的 `main/` 子目录：

```txt
dist/
└── {appId}/
    └── main/
        ├── app-config.json     # 全局配置
        ├── app.css             # 全局样式
        ├── logic.js            # 主包逻辑代码
        ├── pages_index.js      # 页面视图代码，文件名由页面路径转换
        └── pages_index.css     # 页面样式
```

分包会生成与 `main/` 平级的 `sub_<root>/` 目录。使用 `--no-app-id-dir` 时只去掉 `{appId}/` 这一层，`main/` 和分包目录保持不变：

```txt
dist/
└── main/
    ├── app-config.json
    ├── app.css
    ├── logic.js
    ├── pages_index.js
    └── pages_index.css
```

### 常见问题

如果编译失败，按以下顺序排查：

1. 检查小程序目录结构和 `app.json` 配置
2. 检查 `miniprogram_npm` 是否已经构建，项目依赖是否安装完整
3. 使用 `-w` 监听文件变化并查看最新错误
