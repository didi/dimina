import { DMPMap } from '../Utils/DMPMap';
import { DMPContainerBridgesModule } from './DMPContainerBridgesModule';
import { DMPBridgeCallback, DMPBridgeCallbackType } from './DMPTSUtil';
import { DMPApp } from '../DApp/DMPApp';
import { DMPLogger } from '../EventTrack/DMPLogger';
import { Tags } from '../EventTrack/Tags';

const ON_USER_CAPTURE_SCREEN = 'onUserCaptureScreen';
const OFF_USER_CAPTURE_SCREEN = 'offUserCaptureScreen';

/**
 * Screen 模块：屏幕相关能力。
 *
 * 当前包含系统截图监听（对应 JS 侧 onUserCaptureScreen / offUserCaptureScreen）：
 * 用户对小程序窗口截屏时，通过持续回调通知逻辑层，业务侧可借此触发生成分享海报等逻辑。
 * 底层依赖鸿蒙窗口的 'screenshot' 系统事件（SystemCapability.WindowManager.WindowManager.Core）。
 */
export class DMPContainerBridgesModuleScreen extends DMPContainerBridgesModule {
  /** JS 侧注册的持续回调（keep 回调），key 为 FE callback id */
  private jsCallbacks: Map<string, DMPBridgeCallback> = new Map();
  /** 已注册到主窗口的截图监听器，null 表示未注册 */
  private screenshotListener: (() => void) | null = null;

  getExportMethods(): Array<string> {
    return [ON_USER_CAPTURE_SCREEN, OFF_USER_CAPTURE_SCREEN];
  }

  onUserCaptureScreen(data: DMPMap, callback: DMPBridgeCallback) {
    const callbackId = data.getString('callbackId') ?? data.getString('success');
    if (!callbackId) {
      this.invokeFailureCallback(callback, null, `${ON_USER_CAPTURE_SCREEN}:fail`);
      return;
    }
    this.jsCallbacks.clear();
    this.jsCallbacks.set(callbackId, callback);
    if (this.screenshotListener) {
      // 已注册系统监听，仅更新回调
      return;
    }
    const listener = () => {
      this.notifyCaptured();
    };
    try {
      const mainWindow = DMPApp.getWindowStage().getMainWindowSync();
      mainWindow.on('screenshot', listener);
      this.screenshotListener = listener;
      DMPLogger.d(Tags.BRIDGE, `${ON_USER_CAPTURE_SCREEN}: screenshot listener registered`);
    } catch (err) {
      this.jsCallbacks.delete(callbackId);
      DMPLogger.e(Tags.BRIDGE, `${ON_USER_CAPTURE_SCREEN}: register screenshot listener failed: ${err}`);
      this.invokeFailureCallback(callback, null, `${ON_USER_CAPTURE_SCREEN}:fail`);
    }
  }

  offUserCaptureScreen(data: DMPMap, _callback: DMPBridgeCallback) {
    const callbackId = data.getString('callbackId');
    if (callbackId) {
      this.jsCallbacks.delete(callbackId);
    } else {
      this.jsCallbacks.clear();
    }
    if (this.jsCallbacks.size === 0) {
      this.releaseSystemListener();
    }
  }

  /**
   * 截图事件触发，推送给 JS 层。
   * 持续回调场景：仅触发 Success、不触发 Complete，避免 FE 侧 keep 回调被移除。
   */
  private notifyCaptured() {
    DMPLogger.d(Tags.BRIDGE, `${ON_USER_CAPTURE_SCREEN}: screenshot captured`);
    const result = new DMPMap();
    this.emit(this.jsCallbacks, result);
  }

  /** 移除系统截图监听并清空回调；引擎销毁时也会调用，防止泄漏 */
  dispose(): void {
    this.jsCallbacks.clear();
    this.releaseSystemListener();
  }

  private emit(store: Map<string, DMPBridgeCallback>, result: DMPMap): void {
    store.forEach((callback: DMPBridgeCallback) => callback(result, DMPBridgeCallbackType.Success));
  }

  private releaseSystemListener() {
    if (!this.screenshotListener) {
      return;
    }
    try {
      DMPApp.getWindowStage().getMainWindowSync().off('screenshot', this.screenshotListener);
      DMPLogger.d(Tags.BRIDGE, `${OFF_USER_CAPTURE_SCREEN}: screenshot listener unregistered`);
    } catch (err) {
      DMPLogger.e(Tags.BRIDGE, `${OFF_USER_CAPTURE_SCREEN}: unregister screenshot listener failed: ${err}`);
    }
    this.screenshotListener = null;
  }
}
