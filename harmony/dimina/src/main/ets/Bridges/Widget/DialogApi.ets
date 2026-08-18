import { BusinessError } from '@kit.BasicServicesKit';
import { window } from '@kit.ArkUI';
import { entryName } from './DMPDialog';
import { DialogEventManager } from './DialogManager';
import { ModalOption } from './DMPCommonDialog';
import { DMPApp } from '../../DApp/DMPApp';
import { DMPLogger } from '../../EventTrack/DMPLogger';


const MASK_COLOR = '#57050505'; // 蒙层颜色

export class DialogApi {
  private subWindow: window.Window | null = null; // 初始化window实例
  private localStorage: LocalStorage = new LocalStorage(); // 创建页面级UI状态存储对象
  private isFinished: boolean = false;

  private get windowStage(): window.WindowStage | null {
    return DMPApp.getWindowStage();
  }

  // 更新加载内容
  updateOrCreateParams(params: ModalOption) {
    this.localStorage.setOrCreate("title", params.title);
    this.localStorage.setOrCreate("dialogId", params.dialogId);
    this.localStorage.setOrCreate("content", params.content);
    this.localStorage.setOrCreate("confirmText", params.confirmText);
    this.localStorage.setOrCreate("cancelText", params.cancelText);
    this.localStorage.setOrCreate("showCancel", params.showCancel);
    this.localStorage.setOrCreate("cancelColor", params.cancelColor);
    this.localStorage.setOrCreate("confirmColor", params.confirmColor);
  }

  // 展示弹窗
  showDialog = (params: ModalOption) => {
    // 注册回调
    DialogEventManager.getInstance().register(params.dialogId ?? '', (data: string) => {
      if (this.isFinished) {
        return;
      }
      this.hideDialog(params.dialogId ?? '');
      if (data === 'confirm') {
        params?.confirm?.()
      } else {
        params?.cancel?.()
      }
    });

    // 初始化参数
    this.updateOrCreateParams(params);
    // 新建子窗口
    this.createSubWindow(params);
  }
  // 隐藏弹窗
  hideDialog = (dialogId: string) => {
    this.isFinished = true;
    // 注销监听事件
    DialogEventManager.getInstance().unRegister(dialogId);
    // 关闭弹窗
    this.destroySubWindow();
  }

  // 创建子窗口
  private createSubWindow(params: ModalOption) {
    try {
      if (!this.windowStage) {
        this.notifyFailure(params);
        return;
      }
      this.windowStage.createSubWindow('DiminaDialogSubWindow' + params.dialogId, (err: BusinessError, data) => {
        const errorCode: number = err.code;
        if (errorCode) {
          DMPLogger.e("Failed to create the subwindow, Cause: " + JSON.stringify(err));
          this.notifyFailure(params);
          return;
        }

        try {
          this.subWindow = (data as window.Window);

          if (this.subWindow) {
            // 设置子窗口的属性
            this.subWindow.setWindowTouchable(true, (touchableErr: BusinessError) => {
              if (touchableErr.code) {
                DMPLogger.e("Failed to make the window touchable, Cause: " + JSON.stringify(touchableErr));
                this.notifyFailure(params);
                return;
              }
              // 设置窗口UI
              this.loadContent(entryName, params);
            });
          } else {
            this.notifyFailure(params);
          }
        } catch (exception) {
          DMPLogger.e("Failed to configure the window, Cause: " + JSON.stringify(exception));
          this.notifyFailure(params);
        }
      });
    } catch (exception) {
      DMPLogger.e("Failed to create the window, Cause: " + JSON.stringify(exception));
      this.notifyFailure(params);
    }
  }

  private loadContent(path: string, params: ModalOption) {
    if (this.subWindow) {
      this.subWindow.loadContentByName(path, this.localStorage, (err: BusinessError) => {
        const errorCode: number = err.code;
        if (errorCode) {
          DMPLogger.e("Failed to load the content. Cause:" + JSON.stringify(err));
          this.notifyFailure(params);
          return;
        }

        if (this.subWindow) {
          try {
            this.subWindow.setWindowBackgroundColor(MASK_COLOR);
          } catch (exception) {
            DMPLogger.e('Failed to set the background color. Cause: ' + JSON.stringify(exception));
          }
        }
        // 展示子窗口
        this.showSubWindow(params);
      });
    }
  }

  // 显示当前窗口
  private showSubWindow(params: ModalOption) {
    if (this.subWindow) {
      this.subWindow.showWindow((err: BusinessError) => {
        const errCode: number = err.code;
        if (errCode) {
          DMPLogger.e('Fail to show window, Cause: ' + JSON.stringify(err));
          this.notifyFailure(params);
        }
      })
    }
  }

  private notifyFailure(params: ModalOption) {
    if (this.isFinished) {
      return;
    }
    this.isFinished = true;
    DialogEventManager.getInstance().unRegister(params.dialogId ?? '');
    this.destroySubWindow();
    params.fail?.();
  }

  // 销毁当前窗口
  private destroySubWindow() {
    if (this.subWindow) {
      this.subWindow.destroyWindow((err) => {
        const errCode: number = err.code;
        if (errCode) {
          DMPLogger.e('Fail to destroy the window. Cause:' + JSON.stringify(err));
          return;
        }
        this.subWindow = null;
      });
    }
  }
}
