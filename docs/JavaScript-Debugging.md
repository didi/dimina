# Harmony 逻辑层 JavaScript 断点调试

Dimina 的 Harmony 容器里有两套 JavaScript 环境：页面渲染层运行在 WebView，逻辑层运行在
QuickJS。WebView 继续使用 DevEco Studio 的 Web 调试工具；本文只说明 QuickJS 逻辑层的
断点调试。

## 1. 生成 source map

调试包需要使用 DMCC 的 `--sourcemap` 选项。该模式保留未压缩的 `logic.js`，生成
`logic.js.map`，并把源文件记录为相对于最终产物目录的路径：

```sh
dmcc build -c ./miniapp -s ./dist --sourcemap
```

Harmony SDK 为逻辑脚本设置稳定的虚拟路径，不暴露应用沙箱中的真实目录：

```text
/__dimina__/sdk/service.js
/__dimina__/<appId>/main/logic.js
/__dimina__/<appId>/<subpackage>/logic.js
/__dimina__/<appId>/runtime/eval.js
```

## 2. 配置 Harmony 宿主

使用 Debug HAP，并同时打开小程序调试位、设置监听端口：

```ts
const config = new DMPAppConfig('Demo', 'demo-app')
config.isDebugMode = true
config.setJavaScriptDebugger(9229)
```

只有以下条件同时满足时才会启动 QuickJS 调试端口：

- Harmony 原生库编译了 `DIMINA_ENABLE_QUICKJS_DEBUGGER`；CMake Debug 构建默认开启。
- 当前 HAP 的 `debug` 标记为 `true`。
- `appConfig.isDebugMode` 为 `true`，并配置了合法端口。

监听地址固定为设备回环地址 `127.0.0.1`。连接真机或模拟器时，先建立端口转发：

```sh
hdc fport tcp:9229 tcp:9229
```

## 3. 连接 VS Code

安装 VS Code 扩展 `koush.quickjs-debug`，在 `.vscode/launch.json` 中添加 attach 配置。
下面假设源码位于 `miniapp`，DMCC 产物位于 `dist/demo-app`：

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Attach Dimina Harmony QuickJS",
      "type": "quickjs",
      "request": "attach",
      "mode": "connect",
      "address": "127.0.0.1",
      "port": 9229,
      "localRoot": "${workspaceFolder}/miniapp",
      "remoteRoot": "/__dimina__/demo-app/main",
      "sourceMaps": {
        "${workspaceFolder}/dist/demo-app/main/logic.js.map": "/__dimina__/demo-app/main"
      }
    }
  ]
}
```

建立端口转发后启动小程序，再启动 VS Code attach。显式配置端口时，service runtime 会在
执行首个脚本前等待调试器，因此 `app.js` 等入口代码也能命中断点。关闭小程序会取消尚未完成
的调试连接，不会遗留等待线程。

QuickJS 后端支持断点、继续、单步、调用栈、局部变量、闭包变量和表达式求值。一个端口只对应
一个 service runtime；同时调试多个小程序时，需要为每个实例分配不同端口，分包 map 也要按
对应的 `/__dimina__/<appId>/<subpackage>` 路径加入 `sourceMaps`。

## 4. 构建与安全边界

- CMake Release 构建默认不编译调试器；如需强制控制，可显式传入
  `-DDIMINA_ENABLE_QUICKJS_DEBUGGER=ON|OFF`。
- 调试服务只接受设备回环连接，真机访问必须通过 HDC 端口转发。
- 未配置端口时不会创建监听 socket，也不会改变 service runtime 的启动时序。
- 监听失败会记录错误并继续启动业务 runtime。
- 传输协议回归测试位于 `third_party/quickjs-debugger/tests/protocol_test.py`。
