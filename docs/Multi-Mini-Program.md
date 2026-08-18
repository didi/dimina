# 多小程序运行与后台保留

Dimina 在 Android、iOS、HarmonyOS 和 Web 上支持多个不同 `appId` 的小程序运行时并存。该能力用于解决 [Issue #44](https://github.com/didi/dimina/issues/44)：一个小程序打开另一个小程序后，来源实例进入后台但不被销毁，目标实例退出后可以恢复原来的运行状态。

## 运行模型

每个宿主容器或 AppManager 对一个 `appId` 只保留一个权威运行时。多个不同 `appId` 可以同时存在，但任一时刻只有呈现栈栈顶的小程序处于前台：

```text
宿主打开 A       A
A 打开 B         A(后台) -> B(前台)
B 打开 C         A(后台) -> B(后台) -> C(前台)
C 返回 B         A(后台) -> B(前台)
B 返回 A         A(前台)
```

应用登记表只负责按实例身份保存运行时；前后台顺序由独立的呈现栈维护。不能依赖 Map、Dictionary 或数组池的插入顺序推断当前前台实例。

## 生命周期与实例保留

A 通过 `navigateToMiniProgram` 打开 B 时：

1. A 依次触发 App Hide 和当前 Page Hide。
2. A 的 Worker/JS 引擎、页面栈、全局数据和宿主扩展订阅继续保留。
3. B 以场景值 `1037` 启动，`referrerInfo.appId` 指向 A。
4. B 成为唯一可操作的前台小程序；隐藏的 A 不能发起页面或跨小程序导航。

B 调用 `navigateBackMiniProgram` 或 `exitMiniProgram` 后：

1. B 的 Hide、成功/完成回调和页面卸载消息按各端协议进入旧运行时队列。
2. 终止性消息排空后才销毁 B 的页面、Worker/JS 引擎和原生资源。
3. 恢复的仍是原来的 A 实例，不重新触发 `App.onLaunch`。
4. A 以场景值 `1038` 触发 App Show 和当前 Page Show；`navigateBackMiniProgram` 的 `extraData` 放在 `referrerInfo.extraData` 中返回。

这条“隐藏不等于销毁”的边界也适用于宿主直接缓存的 Web `MiniApp`：`closeApp()` 只从呈现栈摘除实例，后续再次 `openApp()` 同一 `appId` 会前置缓存实例；传入 `destroy: true` 才会销毁其它实例。

## 平台实现

| 平台 | 运行时登记 | 前后台呈现 | 后台保留对象 |
| --- | --- | --- | --- |
| Android | `MiniApp` 按 `appId` 保存 `JsCore` 与 Bridge | Activity 返回栈 | QuickJS、来源 Activity 页面栈、按 appId 隔离的原生资源 |
| iOS | `DMPAppManager.appPools` | 共享 `UINavigationController` 的所有权与 opener 关系 | `DMPApp`、JavaScriptCore service、来源页面控制器 |
| HarmonyOS | `DMPAppManager.appPools` | `DMPMiniProgramPresentationStack` | `DMPApp`、Worker/QuickJS、Navigator 页面记录 |
| Web | 容器私有 `AppManager.apps` | `Application.views` | `MiniApp`、Web Worker、iframe 页面栈 |

## 能力边界

- “多个实例”指多个不同 `appId` 的运行时并存；同一管理器内不创建同一 `appId` 的多个独立克隆。
- 跨小程序操作只能由当前栈顶实例发起，返回关系只指向直接 opener，避免隐藏实例修改前台页面栈。
- `restartMiniProgram` 会替换当前实例的完整运行时，不属于后台恢复。
- `exitMiniProgram` 会销毁当前目标实例；它不会销毁仍在呈现栈中的来源实例。
- 后台保留是进程内能力，不是系统级持久化。宿主进程被系统终止后，需要按冷启动或宿主保存的恢复数据重新创建。
- JavaScript 定时器、WebSocket、蓝牙和局域网等能力仍受微信语义及各操作系统后台策略约束。保留运行时不代表这些能力可以无限期在系统后台执行；例如 WebSocket 会按既有后台宽限策略中断。

## 验证建议

接入宿主至少验证以下路径：

1. A 打开 B 后，A 收到一次 Hide，且 A 的运行时身份未变化。
2. B 返回 A 后，A 收到一次 Show，不重复触发 Launch，页面栈和 `globalData` 保持原值。
3. A -> B -> C 连续跳转按后进先出顺序恢复。
4. 隐藏实例发起导航时明确失败，不影响前台实例。
5. 销毁 B 只清理 B 的 Socket、蓝牙、局域网和扩展订阅，不清理 A 的同类资源。
6. A 在后台期间发生的宿主扩展事件仍按 A 的实例身份路由，不会误投递给 B。
