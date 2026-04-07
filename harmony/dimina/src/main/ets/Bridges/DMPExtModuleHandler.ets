import { DMPMap } from '../Utils/DMPMap';

/**
 * 第三方扩展 bridge 模块的回调类，用于将 native 结果传回 JS 层。
 * ArkTS 要求使用 class 而非 interface 的字面量实现，故声明为抽象类。
 */
export abstract class DMPExtCallback {
  abstract onSuccess(result: DMPMap): void;
  abstract onFail(error: DMPMap): void;
}

/**
 * 第三方扩展 bridge 模块处理器接口。
 *
 * 宿主通过 DMPApp.registerExtModule(moduleName, handler) 注册实现，
 * 框架在收到 extBridge / extOnBridge 调用时回调此接口。
 *
 * - 一次性调用（extBridge）：处理后调用 callback.onSuccess/onFail，返回 null。
 * - 持续订阅（extOnBridge）：启动事件监听，返回取消函数；
 *   框架在 extOffBridge 或小程序销毁时自动调用该取消函数。
 */
export type DMPExtModuleHandler = (
  event: string,
  data: DMPMap,
  callback: DMPExtCallback
) => (() => void) | null | undefined;
