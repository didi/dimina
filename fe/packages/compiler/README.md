# 星河小程序编译工具

[![npm version](https://img.shields.io/npm/v/@dimina/compiler.svg?style=flat)](https://www.npmjs.com/package/@dimina/compiler)

## 编译工具

星河小程序编译工具（DMCC）用于将小程序源码编译为星河小程序运行时所需的文件格式。

### 安装

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
```

### 编译流程说明

编译工具会将小程序源码转换为星河小程序运行时可识别的格式：

```txt
app.js, index.js      ->  logic.js     (逻辑文件)
app.ts, index.ts      ->  logic.js     (TypeScript 逻辑文件)
index.wxml            ->  view.js      (视图文件)
app.wxss, index.wxss  ->  style.css    (样式文件)
app.less, index.less  ->  style.css    (Less 样式文件)
app.scss, index.scss  ->  style.css    (SCSS 样式文件)
app.sass, index.sass  ->  style.css    (Sass 样式文件)
app.json, index.json  ->  config.json  (配置文件)
miniprogram_npm/      ->  npm包构建   (npm组件支持)
```

### TypeScript、Less 和 SCSS 支持

编译器现已支持现代前端开发工具：

- ✅ **TypeScript 支持**: `.ts` 文件自动编译为 JavaScript
- ✅ **Less 支持**: `.less` 文件编译为 CSS，支持变量、mixin 和嵌套
- ✅ **SCSS/Sass 支持**: `.scss` 和 `.sass` 文件编译为 CSS
- ✅ **错误处理**: 编译失败时自动回退，不中断构建流程
- ✅ **向后兼容**: 完全兼容现有的 `.js` 和 `.wxss` 文件

#### 支持的文件类型

**逻辑文件查找顺序**: `.js` → `.ts`
**样式文件查找顺序**: `.wxss` → `.ddss` → `.less` → `.scss` → `.sass`

详细使用说明请参考：[TypeScript、Less 和 SCSS 支持文档](./docs/typescript-less-scss-support.md)

### npm 组件支持

编译器现已支持微信小程序的 npm 包功能，遵循微信官方的 npm 支持规范：

- ✅ 支持 `miniprogram_npm` 目录中的组件解析
- ✅ 按照微信小程序寻址顺序查找组件
- ✅ 自动构建和复制 npm 包文件
- ✅ 支持组件依赖关系处理
- ✅ 缓存机制提升编译性能
- ✅ 兼容现有的相对路径组件引用

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

编译后，默认会在目标目录生成以小程序 id 命名的文件夹，项目结构如下：

```txt
dist/
  ├─ {appId}/      # 小程序 ID 目录（使用 --no-app-id-dir 参数可以去除此目录层级）
    ├─ logic.js      # 小程序逻辑代码
    ├─ view.js       # 小程序视图代码
    ├─ style.css     # 小程序样式
    └─ config.json   # 小程序配置
```

如果使用 `--no-app-id-dir` 参数，产物将直接输出到目标目录，而不会创建以 appId 命名的子目录：

```txt
dist/
  ├─ logic.js      # 小程序逻辑代码
  ├─ view.js       # 小程序视图代码
  ├─ style.css     # 小程序样式
  └─ config.json   # 小程序配置
```

### 常见问题

如果编译过程中遇到问题，可以尝试以下解决方法：

1. 确保小程序项目结构正确
2. 检查 app.json 配置是否有效
3. 启用监听模式 (-w) 可以实时查看编译错误
4. 确保依赖安装完整
