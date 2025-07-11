# 小程序 npm 支持

本编译器现已支持微信小程序的 npm 包功能，遵循微信官方的 npm 支持规范。

## 功能特性

- ✅ 支持 `miniprogram_npm` 目录中的组件解析
- ✅ 按照微信小程序寻址顺序查找组件
- ✅ 自动构建和复制 npm 包文件
- ✅ 支持组件依赖关系处理
- ✅ 兼容现有的相对路径组件引用

## 使用方法

### 1. 安装 npm 包

在小程序项目根目录或子目录中安装所需的 npm 包：

```bash
npm install your-miniprogram-component
```

### 2. 构建 npm

使用微信开发者工具的"构建 npm"功能，或者使用命令行工具构建：

```bash
# 使用微信开发者工具
# 工具 -> 构建 npm

# 或者使用 miniprogram-ci
npx miniprogram-ci build-npm --project-path ./
```

构建完成后会生成 `miniprogram_npm` 目录。

### 3. 在页面中使用组件

在页面的 `.json` 配置文件中引用 npm 组件：

```json
{
  "usingComponents": {
    "my-component": "your-miniprogram-component",
    "other-component": "your-miniprogram-component/other"
  }
}
```

### 4. 编译项目

运行 DMCC 编译器，它会自动处理 npm 组件：

## 组件寻址规则

编译器按照以下顺序查找组件：

1. **相对路径组件**（如 `./components/button`）
2. **绝对路径组件**（如 `/components/button`）
3. **npm 包组件**（按微信小程序寻址顺序）

### npm 组件寻址顺序

对于 npm 组件 `"a"`，编译器会按以下顺序查找：

```
[
  // 当前页面目录下的 miniprogram_npm
  "pages/index/miniprogram_npm/a",
  "pages/index/miniprogram_npm/a/index",
  
  // 父级目录的 miniprogram_npm
  "pages/miniprogram_npm/a",
  "pages/miniprogram_npm/a/index",
  
  // 根目录的 miniprogram_npm
  "miniprogram_npm/a",
  "miniprogram_npm/a/index"
]
```

## 项目结构示例

```
miniprogram/
├── app.js
├── app.json
├── pages/
│   └── index/
│       ├── index.js
│       ├── index.json          # 引用 npm 组件
│       ├── index.wxml
│       └── index.wxss
├── miniprogram_npm/            # 构建后的 npm 包
│   ├── vant-weapp/
│   │   ├── button/
│   │   ├── cell/
│   │   └── ...
│   └── other-package/
├── node_modules/               # 原始 npm 包
├── package.json
└── project.config.json
```

## 配置文件示例

### pages/index/index.json
```json
{
  "usingComponents": {
    "lib-button": "lib-weapp/button",
    "lib-cell": "lib-weapp/cell",
    "custom-component": "./components/custom"
  }
}
```

### pages/index/index.wxml
```xml
<view class="container">
  <lib-button type="primary">npm 组件按钮</lib-button>
  <lib-cell title="npm 组件单元格" />
  <custom-component>本地组件</custom-component>
</view>
```

## 支持的文件类型

编译器会处理以下类型的文件：

- `.js` - JavaScript 文件
- `.json` - 配置文件
- `.wxml` - 模板文件
- `.wxss` - 样式文件
- `.ts` - TypeScript 文件
- `.less` - Less 样式文件
- `.scss` - Sass 样式文件
- `package.json` - 包配置文件

## 注意事项

1. **组件标识**：npm 组件必须在其 `.json` 文件中设置 `"component": true`
2. **文件完整性**：组件至少需要包含 `.json` 和 `.js` 文件
3. **路径规范**：遵循微信小程序的组件路径规范
4. **依赖管理**：编译器会自动处理组件间的依赖关系
5. **缓存机制**：重复编译时会使用缓存提升性能

## 错误排查

### 组件找不到
- 确认 `miniprogram_npm` 目录存在
- 检查组件的 `.json` 文件是否正确配置
- 验证组件文件是否完整

### 编译失败
- 检查组件的依赖关系是否正确
- 确认 npm 包是否为小程序兼容版本
- 查看编译器输出的错误信息

## 相关链接

- [微信小程序 npm 支持官方文档](https://developers.weixin.qq.com/miniprogram/dev/devtools/npm.html)
- [小程序自定义组件文档](https://developers.weixin.qq.com/miniprogram/dev/framework/custom-component/)