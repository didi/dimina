# 运行时行为参考

本文说明编译器、Service、Render、Web 容器及原生 SDK 的主要行为契约和适用范围。

## 编译与模块

| 能力 | 当前行为 |
| --- | --- |
| 模板作用域 | 模板以声明文件和名称共同标识；嵌套模板调用使用声明文件的词法作用域。import 不递归暴露依赖模板，同名冲突按导入与本地声明规则处理。 |
| include | 逐文件解析相对路径、展开嵌套 include，终止循环；包含文件内部模板调用保留自身作用域。 |
| WXS 模块 | 内联模块、相对 require 和同名别名按声明文件隔离，缓存模块保留完整依赖。 |
| WXS 类型与标准库 | 类型的 `constructor`、可见属性与方法、Date/RegExp 工厂、字符串转义、函数字符串化和受限全局环境由独立运行时实现；保留局部变量遮蔽、模块共享及方法调用求值顺序。 |
| 列表 | `wx:key="*this"` 保留原始值并容忍空项；普通 key 读取 item 字段。数值 `wx:for` 从 0 开始，有限正小数按循环条件展开；非有限数值生成空列表，防止挂起。 |
| WXSS | `@import` 在原位置展开，保留级联顺序；根路径按项目根解析；循环导入报错。 |
| 重编译 | 模板、WXS 与样式缓存限定在一次编译中，后续编译可读取文件更新；共享模板在一次编译中复用解析结果。 |
| JS 模块 | 循环 require 可读取初始化中的 exports；求值失败可重试。相同 factory 保留缓存，不同 factory 替换；callback require 延后执行，异步失败保留 `mod/errMsg`。 |

新编译产物中的模板作用域信息需要配套更新后的运行时。运行时继续兼容旧产物的模板名称查找。

## 组件、事件与查询

- `getCurrentPages()` 返回新的数组快照，保留页面对象身份。
- observer 内再次 `setData()` 时，未运行的监听器消费最新数据一次，已运行监听器进入后续轮次，避免重复消费同一变化。
- `triggerEvent()` 同步派发，返回 `undefined`；capture、target、bubble 在同一调用栈内完成。跨组件传播按 shadow 和 slot 路径处理 `target` 与 `mark`，退出边界后恢复对应的逻辑节点。
- `Behavior({ definitionFilter })` 在引用者定义准备阶段执行；自身过滤器可接收直接依赖的过滤器数组。Component 和 Page 的过滤发生在合并之前。
- `pureDataPattern` 标记的顶层字段保留在逻辑层并参与 observer，初始数据、增量更新和父属性更新均不会将纯字段写入渲染数据；JSON 配置优先。
- `selectComponent()`、`selectAllComponents()`、`selectOwnerComponent()` 统一调用目标的 `export(owner)`。返回 `undefined` 时使用组件实例，其它返回值原样保留。
- 组件查询支持 `#id`、`.class` 及其复合形式、后代、`>`、`>>>`、逗号分组；普通视图包装、Fragment、组件 shadow 和 slot 均进入逻辑节点树。结果按声明顺序返回，匹配普通视图时保留 `null`；动态重排和删除在 `setData()` 回调前更新到逻辑层。
- SelectorQuery 保留未命中节点的结果位置，返回 `null`；批量查询返回数组。字段读取支持 dataset、尺寸、滚动偏移、properties、computedStyle、mark、viewport，以及现有 Canvas、Video、Map 的 context 恢复与查询作用域。
- SelectorQuery 使用绑定页面的 Bridge 执行，切换页面不会改变已有查询的归属；首次入队或 `.in()` 后固定页面范围，拒绝入队后的跨页 `.in()`。

组件查询不支持标签名或属性选择器。尚未实现的 Editor、LivePlayer 等组件及 ScrollViewContext 不因查询接口补齐而自动具备运行能力；当前节点对象恢复覆盖 Canvas。

## 存储

Service、Web、Android、iOS 和 Harmony 使用带类型的字符串记录传递新写入值。Date、非有限数字、布尔值、null 和嵌套结构可跨 JSON Bridge 保留规定的读取行为。已有原生数据和 Web 命名空间继续可读，内部记录不会与用户对象字段混淆。

容量按用户键和类型记录组成的逻辑 JSON 长度计算，使用 UTF-16 码元数；不计 MMKV 文件分配、数据库记录和框架元数据。`currentSize` 向上取整为 KB，空命名空间为 1 KB；`limitSize` 为 10240 KB。写入按 10 MB 配额检查，替换只计算新值，删除和清空释放逻辑容量，超额写入保留原值。原生端重新计算记录长度，不信任调用方提供的容量元数据。

Web 的实际可用空间还受宿主存储适配器及浏览器容量限制，底层写入失败仍通过 `fail/complete` 返回。

同步写入、删除和清空成功返回 `undefined`，同步配额等宿主写入失败抛出错误。异步读取缺失键走 `fail/complete`；已存 false、0、空串和 null 均保持成功。读取的 `success` 与 `complete` 使用相同的解码结果；`clearStorage()` 支持回调和 Promise。用户对象只进行一次类型序列化，Bridge 使用编码后的快照，Web 落盘不重复保存原值。

## 网络与导航

`request({ responseType: 'arraybuffer' })` 通过二进制编码跨越 JSON Bridge，Service 恢复为 ArrayBuffer，保留空响应及任意字节。HTTP 4xx/5xx 作为已收到的响应进入 success；连接、超时等传输错误进入 fail。JSON 解析接受原始值，解析失败保留响应文本；complete 复用对应 success/fail 的结果，并只触发一次。

Web 的 request 仍由宿主注册；仓库示例处理器与代理承接相同的响应类型。宿主自定义 request 时应保持上述返回契约。

`navigateBack` 按小程序隔离页面栈并处理 delta，保留根页；原生导航确认接受返回后再裁减记录、派发生命周期和返回成功。Android 提前移除待销毁记录，Harmony 跨已存在的 navigator 返回，iOS 保留 API 专用根页保护及 delta 类型归一化。

## 开发检查

前端回归包含编译产物到 Service/Render 的实际 DOM 链路，覆盖首次查询、普通视图包装、slot/shadow、Fragment、重排、删除和跨组件事件；存储回归覆盖特殊字符、精确配额边界、失败覆盖、替换、删除、旧记录和命名空间隔离。原生网络回归通过本地 HTTP 服务验证二进制和状态码行为。

从 `fe/` 执行常规验证：

```sh
pnpm run test
pnpm run lint
pnpm run build
pnpm run compile
```

Android 从 `android/` 执行定向 JUnit：

```sh
./gradlew :dimina:testDebugUnitTest \
  --tests 'com.didi.dimina.api.network.*' \
  --tests 'com.didi.dimina.api.storage.*' \
  --tests com.didi.dimina.api.route.RouteApiTest \
  --tests com.didi.dimina.ui.container.MiniProgramActivityRegistryTest
```

Harmony 从仓库根目录执行受控宿主测试：

```sh
node --test harmony/scripts/request-query.test.mjs \
  harmony/scripts/storage-contract.test.mjs \
  harmony/scripts/navigation-back.test.mjs
```

这些 Harmony 测试加载真实 ArkTS/TypeScript 模块，并使用受控宿主、网络和存储适配，不等同于 Harmony SDK 编译或真机运行。

## 能力边界

本文说明明确列出的行为。设备权限、系统面板、蓝牙、相机、定位、支付登录和媒体能力还受宿主接入及系统策略影响。未列出的 WXS 边界输入、未实现组件、私有扩展和其他渲染引擎行为，不属于本文的能力保证。
