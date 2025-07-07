# 全局 usingComponents 支持

## 概述

Dimina 编译器现在支持在 `app.json` 中配置全局 `usingComponents`，这与微信小程序官方规范完全一致。全局配置的组件可以在所有页面中直接使用，无需在每个页面的配置文件中重复声明。

## 功能特性

### 1. 全局组件声明

在 `app.json` 中声明的组件会自动注入到所有页面中：

```json
{
  "pages": ["pages/index/index", "pages/about/about"],
  "usingComponents": {
    "global-button": "./components/global-button/index",
    "global-header": "./components/global-header/index",
    "vant-button": "vant-weapp/button"
  }
}
```

### 2. 页面级覆盖

页面级的 `usingComponents` 配置具有更高的优先级，可以覆盖全局组件：

```json
// pages/about/about.json
{
  "usingComponents": {
    "global-button": "./components/page-button/index"
  }
}
```

### 3. 分包支持

分包中的页面也会继承全局组件配置：

```json
{
  "pages": ["pages/index/index"],
  "subPackages": [{
    "root": "packageA",
    "pages": ["pages/detail/detail"]
  }],
  "usingComponents": {
    "global-button": "./components/global-button/index"
  }
}
```

### 4. npm 组件支持

支持在全局配置中使用 npm 组件：

```json
{
  "usingComponents": {
    "vant-button": "vant-weapp/button",
    "vant-cell": "vant-weapp/cell"
  }
}
```

## 实现原理

### 1. 配置收集阶段

在 `storePageConfig()` 函数中，编译器会首先处理 `app.json` 中的全局 `usingComponents`：

```javascript
// 首先处理 app.json 中的全局 usingComponents
if (configInfo.appInfo.usingComponents) {
    const appFilePath = `${pathInfo.workPath}/app.json`
    storeComponentConfig(configInfo.appInfo, appFilePath)
}
```

### 2. 页面配置合并

在 `getPages()` 函数中，全局组件配置会与页面级配置合并：

```javascript
const { pages, subPackages = [], usingComponents: globalComponents = {} } = getAppConfigInfo()

const mainPages = pages.map(path => {
    const pageComponents = pageInfo[path]?.usingComponents || {}
    // 合并全局组件和页面组件，页面组件优先级更高
    const mergedComponents = { ...globalComponents, ...pageComponents }
    
    return {
        id: uuid(),
        path,
        usingComponents: mergedComponents,
    }
})
```

### 3. 编译阶段

在编译阶段，编译器会处理合并后的 `usingComponents` 配置，确保所有组件都能正确编译和引用。

## 使用示例

### 基本用法

```json
// app.json
{
  "pages": ["pages/index/index"],
  "usingComponents": {
    "my-button": "./components/my-button/index"
  }
}
```

```xml
<!-- pages/index/index.wxml -->
<view>
  <!-- 直接使用全局组件，无需在页面配置中声明 -->
  <my-button>点击我</my-button>
</view>
```

### 页面级覆盖

```json
// pages/special/special.json
{
  "usingComponents": {
    "my-button": "./components/special-button/index"
  }
}
```

```xml
<!-- pages/special/special.wxml -->
<view>
  <!-- 这里使用的是页面级的 special-button 组件 -->
  <my-button>特殊按钮</my-button>
</view>
```

## 测试覆盖

编译器包含了完整的测试用例，覆盖以下场景：

1. **基本全局组件功能**：验证全局组件能正确注入到所有页面
2. **页面级覆盖**：验证页面级组件能正确覆盖全局组件
3. **分包支持**：验证分包页面能继承全局组件
4. **npm 组件支持**：验证 npm 组件能在全局配置中使用

## 兼容性

- ✅ 完全兼容微信小程序官方规范
- ✅ 支持现有项目无缝升级
- ✅ 向后兼容，不影响现有功能

## 注意事项

1. **优先级**：页面级 `usingComponents` 优先级高于全局配置
2. **性能**：全局组件会增加主包体积，建议合理使用
3. **依赖管理**：编译器会自动处理组件间的依赖关系
4. **路径解析**：支持相对路径和 npm 包路径

## 相关链接

- [微信小程序官方文档 - 全局配置](https://developers.weixin.qq.com/miniprogram/dev/reference/configuration/app.html#usingComponents)
- [Dimina 编译器文档](../README.md)
- [示例项目](../examples/global-components-demo/) 