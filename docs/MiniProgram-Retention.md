# 小程序多实例与后台留存

不同 appId 可以同时保留运行状态；同一个 appId 从宿主入口再次打开时优先复用仍在缓存中的实例，恢复当前页面栈。实例已被回收时走冷启动，重新执行 `App.onLaunch`、`Page.onLoad`。

## 关闭界面与销毁实例

点击原生胶囊或菜单的关闭按钮，会隐藏界面并保留 JS 运行时和页面。Web 的 `closeApp` 同样保留实例。隐藏时派发页面和应用的隐藏生命周期，恢复时派发显示生命周期；隐藏不会触发页面卸载。

宿主主动销毁、重新进入、应用更新和卸载继续使用原来的清理流程。小程序自身的 `exitMiniProgram`、`navigateBackMiniProgram` 等显式路由 API 保持现有契约。

| 平台 | 隐藏并保留 | 再次打开 | 主动销毁 |
| --- | --- | --- | --- |
| Android | `Dimina.hideMiniProgram(appId)` | `startMiniProgram(activity, miniProgram)` | `Dimina.closeMiniProgram(appId)` |
| iOS | `try await app.hideMiniProgram()` | `appWithConfig` 取得实例，设置导航控制器后 `await app.launch(...)` | `try await app.closeMiniProgram()` |
| Harmony | `await app.hideMiniProgram()` | `appWithConfig` 取得实例后 `startDimina(...)` | `await app.closeMiniProgram()` |
| Web | `container.closeApp(app)` | `container.openApp({ appId })` | `container.application.destroyRootView(app)` |

Web 基础示例列表打开小程序时不再传入 `destroy: true`。宿主仍可显式传入该选项，在打开新小程序时释放其他实例。

上述“主动销毁”属于 Dimina 的宿主接口契约，会释放页面与运行时，保留 Storage 等持久化数据。`exitMiniProgram` 在当前 Dimina 中也会销毁实例；不要将这一实现约定当作微信客户端保证立即回收进程或内存的承诺。

## 销毁所有小程序实例

原生宿主可调用 `destroyAllMiniPrograms`，关闭前台、后台保活及跨小程序来源实例，释放页面、JS 引擎、连接和订阅。不会恢复来源小程序，不卸载代码包，不清除 Storage 或文件系统等持久化数据；如需清理或隔离持久化数据，由宿主另行处理。

```kotlin
// Android，主线程；旧 Activity 的退出和引擎销毁在系统/引擎队列中完成。
Dimina.getInstance().destroyAllMiniPrograms()
```

```swift
// iOS，MainActor
try await DMPAppManager.sharedInstance().destroyAllMiniPrograms()
```

```typescript
// Harmony，UI 线程
await DMPAppManager.sharedInstance().destroyAllMiniPrograms()
```

调用前暂停宿主的新启动请求，成功后再恢复新的小程序启动请求。空实例池和已完成后的重复调用安全；再次打开走冷启动。iOS / Harmony 与进行中的跨小程序导航、安装/卸载事务冲突时会抛出错误，iOS 也会拒绝与正在启动或页面路由中的实例重叠；等待该操作完成后重试，不应吞掉错误并当作全部实例销毁成功。Harmony 某个实例关闭失败时会继续尝试其他实例，最后报告失败，可重试剩余实例。

Android 会使调用前已发出的启动 Intent 失效，取消已登记页面的初始化任务，并防止旧页面晚到的销毁回调清理新实例。小程序的 TabBar 随所属页面一起释放；共享任务/导航栈中的宿主页面保留。

## 再次进入的参数和生命周期

从宿主重新打开缓存实例时，页面栈保持不变，`App.onShow` 的 `path/query` 对应当前页面，`scene/referrerInfo` 使用本次进入参数。未提供场景值时按宿主入口 `1001` 处理，不复用旧的来源小程序信息。完成返回后，旧的来源关系不再用于后续后台销毁。

Android 的 `startMiniProgram` 显式提供 `path`，或 iOS / Harmony 的 `DMPLaunchConfig` 提供 `appEntryPath/query` 时，`App.onShow` 和 `getEnterOptionsSync()` 使用本次进入的路径及 query；显式路径不含 query 且未另传 query 时返回空对象，不沿用旧参数。未提供路径时，使用保留的当前页面参数。Android 会在同一 JS 运行时保存最近一次明确进入的参数，后续从最近任务列表或系统前后台恢复时继续使用，直到下一次明确进入替换它，或运行时销毁后清除。iOS / Harmony 当前仍仅覆盖此次进入事件，普通系统前后台切换重新读取当前页面的 path/query。热启动不重新执行 `App.onLaunch`，`globalData` 继续保留，`getLaunchOptionsSync()` 仍返回该实例首次冷启动的参数；只有销毁后重新初始化才更新首次启动参数。这项参数更新不重建保留的页面栈，也不额外触发 `Page.onLoad`。

隐藏依次触发当前页的 `Page.onHide` 和 `App.onHide`，恢复依次触发 `App.onShow` 和当前页的 `Page.onShow`。宿主仍在系统后台时，重新挂载页面不等于实际显示，显示生命周期等到宿主回到前台时再派发。

## 各平台如何保留页面

- Android：每个小程序入口使用独立的 Activity 任务栈。重新打开时将原任务移到前台，保留子页面和已加载的 Tab；普通页面导航仍在同一任务内进行。关闭界面返回调用方任务，小程序任务可出现在系统最近任务列表中。不会使用 `CLEAR_TOP` 截断原页面栈。
- iOS：导航器保留原页面控制器及其 WebView，隐藏时将它们从宿主导航栈摘除。恢复时重新挂载原控制器，销毁时释放保存的页面。
- Harmony：隐藏时只移除原生路由入口，保留页面记录、Web 节点、JS Worker 和 TabBar 状态。恢复时根据原记录重建路由壳，继续使用原 Web 节点。键盘和事件订阅跟随界面解绑，TabBar 消息按 appIndex 隔离。
- Web：继续使用容器私有的 appId 实例登记表，保留逻辑 Worker、页面 bridge 与 iframe。

Android、iOS 和 Harmony 的后台实例不能操作前台导航栈。销毁后台实例只释放自己的资源，不弹出其他小程序或宿主的页面。

## 生命周期与资源边界

留存状态属于当前宿主进程，不是磁盘快照。宿主进程被系统终止、Android 后台 Activity 被回收或实例被显式销毁后，下一次打开走冷启动。后台留存不申请操作系统后台执行权限，也不保证宿主切到系统后台后定时器或网络任务继续执行。

每个保留实例仍占用 JS 和 WebView 内存，宿主可通过主动销毁入口释放不再需要的实例。Harmony 隐藏期间的 TabBar 更新在恢复时应用；待处理更新最多 128 条，超过上限会失败，避免无限积压。

四端共用逻辑层的协作式挂起：`App.onHide` 执行后暂停 `setTimeout`、`setInterval` 和普通业务消息回调，包括网络、扩展事件与 Canvas 动画回调。`App.onShow` 时恢复，定时器继续剩余等待时间，周期定时器不补跑隐藏期间错过的次数。业务消息按接收顺序恢复，每条消息保留独立任务边界，让它产生的 Promise 微任务在下一条消息前完成。浏览器使用一个 `MessageChannel`，原生运行时使用计时器调度，始终只保留一个待执行的恢复任务。已经失效的定时器回调不会在快速隐藏、恢复后重复执行。

资源初始化、页面生命周期、销毁屏障和跨小程序导航的成功/失败/完成回调继续分发，避免隐藏后的退出或重启操作互相等待。挂起不抢占正在执行的 JS 或微任务，不冻结整个 Worker、WebView、原生网络或媒体任务；已到达但尚未分发的业务消息仍占用内存。原生能力继续遵循各自的隐藏与销毁规则。

原生宿主需要同步更新共享 JSSDK 中的 `service.js`，才能启用上述挂起逻辑；只升级原生 SDK、继续使用旧 JSSDK 时，只会生效原生实例回收策略。

## 宿主留存策略

| 配置 | 默认值 | 含义 |
| --- | --- | --- |
| `maxBackgroundApps` | `3` | 可回收后台缓存实例的数量上限；`0` 表示界面关闭后不留存 |
| `backgroundTimeoutMs` | `300000` | 自最近一次隐藏起的超时，单位毫秒；`0` 关闭超时回收 |

配置必须是非负整数。这些默认值属于 Dimina，不是微信客户端固定数量或时长的承诺。配置更新后会重新检查已有缓存。

超限时按最近使用顺序回收：最早隐藏且此后未重新显示的实例最先释放。重复隐藏不会延长超时；显示后再次隐藏才开始新的留存周期。每个管理器只维护最近一个到期计时器，不轮询、不为每个实例创建回收计时器。宿主进程被系统挂起期间不能保证准点执行；启动入口会在复用前再次检查期限。

当前展示的实例，以及跨小程序导航中尚未解除的来源链，属于受保护的展示关系，不计入可回收缓存上限。宿主整体进入系统后台也不会立即解除该关系。因此总运行实例数可以大于 `maxBackgroundApps`，该配置不是进程总实例数的硬上限。实例脱离展示关系后才允许自动销毁，避免破坏返回页面与来源关系。

Harmony 某个实例关闭失败时保留其留存记录，并继续处理其他实例；下次配置、真实显示变化或内存压力事件可以重试，不针对失败实例反复启动立即到期的计时器。

内存压力会释放所有可回收后台实例，保留受保护的展示关系；之后再次打开被回收实例走冷启动。回收释放运行时、页面和实例资源，不清除 Storage 或用户文件，也不自动打开其他小程序。

### Android

在主线程配置；调用 `Dimina.init` 后即可设置：

```kotlin
import com.didi.dimina.core.RetentionPolicy

dimina.configureRetention(RetentionPolicy(maxBackgroundApps = 3, backgroundTimeoutMs = 300_000))
```

SDK 自动监听应用的 `onLowMemory` 及低内存级别的 `onTrimMemory`，单纯的 `TRIM_MEMORY_UI_HIDDEN` 不当作内存告警。宿主也可主动调用 `dimina.notifyMemoryPressure()`。

### iOS

在主线程配置：

```swift
DMPAppManager.sharedInstance().configureRetention(
    DMPRetentionPolicy(maxBackgroundApps: 3, backgroundTimeoutMs: 300_000)
)
```

SDK 自动监听 `UIApplication.didReceiveMemoryWarningNotification`。宿主可在主线程主动调用 `DMPAppManager.sharedInstance().notifyMemoryPressure()`。

### Harmony

```typescript
import { DMPAppManager, DMPRetentionPolicy } from 'dimina'

DMPAppManager.sharedInstance().configureRetention(new DMPRetentionPolicy(3, 300000))
```

启动时 SDK 向应用上下文注册一次环境监听，在 `onMemoryLevel` 中发起回收。宿主也可主动调用 `DMPAppManager.sharedInstance().notifyMemoryPressure()`。

### Web

```typescript
const container = createContainer({
  mount,
  retention: { maxBackgroundApps: 3, backgroundTimeoutMs: 300000 },
})
container.configureRetention({ maxBackgroundApps: 1, backgroundTimeoutMs: 60000 })
container.notifyMemoryPressure()
```

配置和实例池按容器隔离。浏览器没有通用且可靠的内存告警事件，因此 Web 内存压力入口由宿主触发，不依据不可靠的堆大小估算主动淘汰。

Harmony 的 `customLaunchPageCallBack` 自定义挂载页面没有框架路由入口，由宿主负责隐藏和恢复，不适用默认路由隐藏方法。

## 验证

1. 打开小程序 A，进入二级页面并修改页面状态。
2. 点击胶囊关闭，打开小程序 B，再关闭 B。
3. 再次打开 A：应恢复原二级页面及状态，不重新执行启动和页面加载生命周期。
4. 在二级页面返回：应回到 A 的上一级；Android、Harmony 的栈底系统返回应隐藏小程序。
5. 对后台 A 调用宿主关闭接口：B 的前台界面不应变化，再次打开 A 应冷启动。
6. TabBar 场景重复上述操作，检查选中项、已加载 Tab、徽标及页面状态。
7. 从不同场景重新打开同一实例，检查进入参数更新、旧来源关系清除，以及系统前后台切换后参数不回退。

8. 把后台上限设为 1，依次关闭 A、B：A 应被回收；重新打开 A 应冷启动。
9. 缩短超时，检查到期回收、显示后取消旧期限，以及回收时其他前台小程序不受影响。
10. 主动发起内存压力，检查后台缓存释放；当前展示实例与返回来源链仍可使用。
11. 隐藏期间检查业务定时器和回调不执行，恢复后顺序正确；隐藏后的退出/重启回调与销毁屏障仍能完成。

回归入口：

- Android：`:dimina:testDebugUnitTest`，其中 `BackgroundRetentionTest` 覆盖容量、期限与内存压力；界面仍需示例应用中的任务栈切换验证。
- iOS：`DMPRetainedMiniProgramTests` 和 `DMPNavigatorCapsuleTests`。
- Web：`retention-policy.spec.ts`、`retained-mini-program.spec.ts` 与容器 SDK 现有生命周期、并发打开测试。
- 共享逻辑层：`background-scheduler.spec.js`、`background-lifecycle.spec.js`，验证挂起、恢复、定时器剩余时间和终止性回调的顺序。
- Harmony：安装前端依赖后执行 `node --test harmony/scripts/retained-pages.test.mjs`；ArkUI 编译通过 `dimina:assembleHar` 验证，实际界面复用仍需设备验证。

### 业务执行回归

自动回归同时验证公开 API 的业务状态和管理器的资源状态：

- `App.globalData` 经 API 成功回调及 Promise 链修改后，完成回调能读取到最终状态。
- 恢复过程中同步回调重入、Promise 再次隐藏、消息积压和旧定时器迟到，保持顺序与恰好一次执行。
- Web 过期重开会冷启动，内存压力不影响其他容器或跨小程序返回链。
- Android/iOS 再次显示取消旧期限，再次隐藏创建新期限；iOS 导航事务期间暂缓回收。
- Harmony 关闭失败不会丢失留存记录、阻断其他实例回收或立即循环重试。

前端工作流会自动运行共享逻辑层、Web 容器及 Harmony 便携回归；Harmony 源码及脚本变更也会触发该工作流。Android 和 iOS 用例沿用各自的测试工作流。便携测试与模拟器测试不能替代真机压力和长时间运行验证。

### 批量销毁检查

- Android：检查登记表、可见性和留存策略，销毁后不能查到旧 Activity。
- iOS：检查前台、后台保活、共享导航栈、重复调用和导航事务冲突，确保来源页面不残留、栈顶回到宿主页面。
- Harmony：检查保活状态和批量关闭顺序，展示栈与实例记录应保持一致。

待启动 Intent、初始化取消、延迟 WebView 回调和路由动画可能同时发生，接入时应覆盖这些并发场景。持久化数据清理不属于此 API 的职责。

### Android 同 appId 的系统任务复用

多任务模式下，宿主入口以 appId 查找已有任务，业务 path/query 不参与实例标识。先选择仍有效的页面 Activity；最后登记的页面正在结束时，继续查找同 appId 的有效页面。内存登记丢失时，再查询 Android 保留的系统任务，找到后移动原任务到前台，并交付本次入口参数，避免直接以 `MULTIPLE_TASK` 创建新任务。

任务根 Intent 的 data URI 保存 appId 及销毁代次标记，不包含业务路径与 query。[Android 12 的 `Task.fillTaskInfo`](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/android12-release/services/core/java/com/android/server/wm/Task.java) 在剥离 extras 时使用 `cloneFilter()`，因此不能仅依赖 Parcelable extras 识别任务。只有组件属于 Dimina 且身份匹配的任务可作为系统查找候选；同一进程主动销毁前的任务标记失效。旧任务没有标识且其 extras 已丢失时无法可靠判断归属，不按名称或页面地址猜测匹配。

这保证任务复用的查找不依赖业务 query；系统杀死进程后 JS 运行时仍须重新初始化，不能承诺保留进程内 globalData。关闭多任务模式时仍遵循原有宿主共享栈策略。
