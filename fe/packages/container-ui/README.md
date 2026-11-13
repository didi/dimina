# 容器公共 UI

Web 演示与桌面宿主共用应用列表的 DOM、搜索过滤、加载/空态、打开状态及 Logo 处理。宿主负责提供目录和操作，不依赖手机壳、浏览器路由、AI 工作区或 MyGo。

```js
import { AppListView, getAppInfo } from '@dimina/container-ui'
import '@dimina/container-ui/style.css'

const list = new AppListView({
  loadApps: async () => (await host.listApps()).map(getAppInfo),
  onOpen: app => host.openApp(app.appId),
  refreshable: true,
  action: {
    label: '导入小程序',
    onClick: () => host.importApp(),
    refreshAfter: true,
  },
})
mount.appendChild(list.el)
await list.refresh()
```

`setExtraApps()` 提供置顶的本地生成项目；`generated: true` 的条目显示生成项目标识，打开动作仍交给宿主。操作返回 `false` 表示取消，`refreshAfter` 不会刷新目录；异常在列表中显示。宿主移除整个视图时调用 `destroy()`，解除事件监听并忽略未完成的异步结果。

共享样式只包含组件基本结构与交互状态。手机模拟器的缩放、顶部状态栏以及桌面窗口的字号、间距由各宿主样式配置。此包为工作区内部源码包，由宿主 Vite 构建内联，不单独发布。
