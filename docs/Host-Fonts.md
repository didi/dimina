# 复用宿主 App 的字体

宿主 App 可以注册已有字库，小程序通过 `wx.loadFontFace` 按需启用，无需将相同字库再次放进各自的小程序包。Android、iOS、Harmony 的宿主接口不同，小程序使用相同的字体 ID。

## 宿主注册

在启动小程序前完成注册。ID 允许 1～128 个英文字母、数字、下划线或连字符，支持 TTF、OTF、WOFF、WOFF2；字体文件本身仍需兼容目标系统的 WebView。

Android：

```kotlin
import com.didi.dimina.HostFonts

// 复用 App 的 assets/fonts/Brand-Regular.ttf。
HostFonts.registerAsset("brand-regular", applicationContext, "fonts/Brand-Regular.ttf")
// 也可以注册宿主已有的可读文件。
HostFonts.registerFile("brand-bold", fontFile)
```

iOS：

```swift
if let url = Bundle.main.url(forResource: "Brand-Regular", withExtension: "ttf") {
    try DMPHostFonts.register("brand-regular", fileURL: url)
}
```

不需要额外注册 `UIFont`。字体文件也可以来自宿主的其他 Bundle 或可读本地目录。

Harmony：

```typescript
import { DMPHostFonts } from '@didi-dimina/dimina';

DMPHostFonts.registerRawFile("brand-regular", $rawfile("fonts/Brand-Regular.ttf"), "ttf");
// 也可以注册宿主已有的可读文件。
DMPHostFonts.registerFile("brand-bold", fontFilePath);
```

以上资源在宿主注册表中共享。注册本身不向页面注入字体，也不改变系统字体。小程序只能按已注册的 ID 读取资源，不能传任意宿主文件路径。

## 小程序启用

```javascript
wx.loadFontFace({
  family: 'AppBrand',
  source: 'url("dimina-font://brand-regular")',
  global: true,
  desc: { style: 'normal', weight: '400' },
  success() {
    console.log('字体已加载')
  },
  fail(error) {
    console.error(error.errMsg)
  },
})
```

```css
.brand-text {
  font-family: 'AppBrand', sans-serif;
}
```

`dimina-font://` 是 Dimina 的宿主资源扩展，不能直接用于微信客户端。`family` 是小程序定义的 CSS 别名，可以和字库内部名称不同。使用独立别名，可保证调用 API 前使用 CSS 回退字体。

- `global` 默认 `false`，只作用于调用时的页面；设为 `true` 后作用于当前小程序已有页面及后续新页面。全局字体在新页面首次渲染前尝试加载，失败仍允许页面使用回退字体。
- 不传回调函数时返回 Promise；成功结果为 `{ errMsg: 'loadFontFace:ok', status: 'loaded' }`，失败触发 `fail` 或拒绝 Promise，并提供 `errMsg` 和 `status: 'failed'`。`complete` 在本次调用结束时执行一次。
- `desc` 支持 `style`、`weight`、`variant`。`scopes` 仅支持 `['webview']`，省略时也使用此范围；不支持原生组件和小游戏字体注册。
- 也支持普通网络来源，例如 `source: 'url("https://example.com/Brand.woff2")'`，需满足 WebView 的 HTTPS、同源或 CORS 要求。Web 端可加载网络字体；宿主字体来源仅供三个原生平台使用。
- 相同字体的重复调用复用当前文档内的加载结果。不同小程序的启用状态独立，页面销毁及 WebView 复用时清除框架注册的字体。

宿主可调用 `HostFonts.unregister(id)`（Android）或 `DMPHostFonts.unregister(id)`（iOS、Harmony）移除资源映射；这不会撤销已有页面中已经加载的字体。运行期间不应覆盖正在使用的 ID 或字体文件；更新字库时使用新的 ID，或在小程序完全退出后更新。

此功能减少字库重复打包和网络传输，不保证多个 WebView 共享同一份字体解码内存。成功回调说明字体已完成加载并注册，不代表屏幕已完成下一帧绘制。

## 构建与接入

该能力需要同时更新原生 SDK 和 JSSDK。在仓库中按[共享资源说明](../shared/README.md)执行 `pnpm build`、`pnpm generate:sdk`，再构建对应原生平台。生成 JSSDK 会更新 `shared/jssdk` 的版本与压缩包；已集成的宿主也应同步交付这两个部分。
