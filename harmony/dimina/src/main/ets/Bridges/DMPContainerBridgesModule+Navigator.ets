import { DMPApp } from '../DApp/DMPApp'
import { DMPLaunchType } from '../DApp/config/DMPAppConfig'
import { DMPContainerBridgesModule } from './DMPContainerBridgesModule'

import { DMPBridgeCallback } from './DMPTSUtil'
import { DMPFileManager } from '../Bundle/Util/DMPFileManager'
import { DataTransformer } from '../Utils/DataTransformer'
import { DMPLogger } from '../EventTrack/DMPLogger'
import { DMPMap } from '../Utils/DMPMap'
import { Tags } from '../EventTrack/Tags'
import { DMPJavaScriptSourceURL } from '../Service/DMPJavaScriptSourceURL'

export class DMPContainerBridgesModuleNavigator extends DMPContainerBridgesModule {
  getExportMethods(): string[] {
    return [
      'applyUpdate',
      'navigateTo',
      'navigateBack',
      'getLocalFilePath',
      'redirectTo',
      'reLaunch',
      'loadSubPackage',
      'switchTab'
    ];
  }

  async loadSubPackage(data: DMPMap, callback: DMPBridgeCallback) {
    DMPLogger.i(Tags.SUB_PKG_MANAGER, ' loadSubPackage start data:' + data.toStr());
    try {
      let packageName: string = data.get("package")!;
      if (!packageName) {
        packageName = 'main'
      }
      if (packageName == 'main') {
        DMPLogger.i(Tags.SUB_PKG_MANAGER, ' loadSubPackage 主包加载成功 moduleName=' + packageName);
        this.invokeSuccessCallback(callback, new DMPMap());
        return
      }
      await this.exeJsLogicScript(packageName)
      DMPLogger.i(Tags.SUB_PKG_MANAGER, 'loadSubPackage 子包安装成功  moduleName=' + packageName);
      this.invokeSuccessCallback(callback, new DMPMap());
    } catch (e) {
      this.invokeFailureCallback(callback, null, e.toString());
      DMPLogger.e(Tags.SUB_PKG_MANAGER, e.toString());
    }
  }

  getLocalFilePath(data: DMPMap, callback: DMPBridgeCallback) {
    let path: string = data.get("path")!;
    let pack: string | undefined = data.get('package');
    if (!pack) {
      pack = 'app'
    }
    const app: DMPApp = this.app!
    const filePath = app.bundleManager.getCurrentJSAppDir() + '/app'

    let debugPath = filePath + '/' + path;

    if (app.appConfig.launchAppType === DMPLaunchType.DebugUrl) {
      const result: DMPMap = new DMPMap();
      result.set('path', debugPath);
      this.invokeSuccessCallback(callback, result);
      return;
    }
    if (DMPFileManager.fileExist(debugPath, app.appConfig.launchAppType)) {
      const result: DMPMap = new DMPMap();
      result.set('path', debugPath);
      this.invokeSuccessCallback(callback, result);
    } else {
      this.invokeFailureCallback(callback, null, 'file not exist');
    }
  }

  reLaunch(data: DMPMap, callback: DMPBridgeCallback) {
    DMPLogger.d("reLaunch", data.toStr())
    const navigator = this.app.navigatorManager.getCurNavigator()
    if (navigator) {
      let url: string = data.get('url')
      let routerParam = DataTransformer.parse(url)
      navigator.relaunchTo(routerParam)
    }
    this.invokeSuccessCallback(callback, null);
  }

  navigateTo(data: DMPMap, callback: DMPBridgeCallback) {
    DMPLogger.d("navigateTo", data.toStr())
    const navigator = this.app.navigatorManager.getCurNavigator()
    if (!navigator) {
      this.invokeFailureCallback(callback, null, 'navigateTo:fail no current navigator')
      return
    }
    let url: string = data.get('url')
    let routerParam = DataTransformer.parse(url)
    navigator.navigateTo(routerParam)
      .then(() => {
        this.invokeSuccessCallback(callback, null)
      })
      .catch((err: Error) => {
        // 来源：DMPNavigator.navigateTo —— 例如目标是 tabBar 页面被拦截
        this.invokeFailureCallback(callback, null, err?.message ?? 'navigateTo:fail')
      })
  }

  redirectTo(data: DMPMap, callback: DMPBridgeCallback) {
    DMPLogger.d("redirectTo", data.toStr())
    const navigator = this.app.navigatorManager.getCurNavigator()
    if (!navigator) {
      this.invokeFailureCallback(callback, null, 'redirectTo:fail no current navigator')
      return
    }
    let url: string = data.get('url')
    let routerParam = DataTransformer.parse(url)
    navigator.redirectTo(routerParam)
      .then(() => {
        this.invokeSuccessCallback(callback, null)
      })
      .catch((err: Error) => {
        // 来源：DMPNavigator.redirectTo —— 例如目标是 tabBar 页面被拦截
        this.invokeFailureCallback(callback, null, err?.message ?? 'redirectTo:fail')
      })
  }

  async navigateBack(data: DMPMap, callback: DMPBridgeCallback) {
    const manager = this.app.navigatorManager
    try {
      const pageCount = manager.navigationPageCount()
      if (pageCount <= 1) {
        throw new Error('navigateBack:fail cannot navigate back at first page.')
      }
      const requested = data.getNumber('delta')
      const delta = typeof requested === 'number' && Number.isFinite(requested)
        ? Math.max(Math.trunc(requested), 1) : 1
      let remaining = Math.min(delta, pageCount - 1)
      while (remaining > 0) {
        const navigator = manager.getCurNavigator()
        const count = Math.min(remaining, navigator?.getPageCount() ?? 0)
        if (!navigator || count < 1) throw new Error('navigateBack:fail no current navigator')
        const before = manager.navigationPageCount()
        await navigator.navigateBack(count)
        const removed = before - manager.navigationPageCount()
        if (removed <= 0) throw new Error('navigateBack:fail page stack did not change')
        remaining -= removed
      }
      this.invokeSuccessCallback(callback, new DMPMap({ errMsg: 'navigateBack:ok' }))
    } catch (error) {
      const message = (error as Error).message ?? ''
      this.invokeFailureCallback(callback, null, message.startsWith('navigateBack:fail')
        ? message : `navigateBack:fail ${message}`)
    }
  }

  switchTab(data: DMPMap, callback: DMPBridgeCallback) {
    DMPLogger.d("switchTab", data.toStr())
    const navigator = this.app.navigatorManager.getCurNavigator()
    if (!navigator) {
      this.invokeFailureCallback(callback, null, 'switchTab:fail no current navigator')
      return
    }
    let url: string = data.get('url')
    let routerParam = DataTransformer.parse(url)
    navigator.switchTab(routerParam)
      .then(() => {
        this.invokeSuccessCallback(callback, null)
      })
      .catch((err: Error) => {
        // 错误信息源自 DMPNavigator.switchTab：目标不在 tabBar.list / 栈空 / event emit 失败
        this.invokeFailureCallback(callback, null, err?.message ?? 'switchTab:fail')
      })
  }

  applyUpdate(data: DMPMap, callback: DMPBridgeCallback) {
    const app: DMPApp = this.app!
    app.updateApp().then((updated: boolean): void => {
      if (updated) {
        this.invokeSuccessCallback(callback, null)
      } else {
        this.invokeFailureCallback(callback, null, 'applyUpdate:fail no pending update')
      }
    }).catch((error: Error): void => {
      this.invokeFailureCallback(callback, null, `applyUpdate:fail ${error.message}`)
    })
  }

  private async exeJsLogicScript(packageName: string) {
    if (packageName != 'main') {
      DMPLogger.d(Tags.SUB_PKG_MANAGER, "执行逻辑层 package=" + packageName)
      let data = await this.app.bundleManager.bundleLoader.requestModuleService(packageName)
      this.app.service.executeScript(
        data,
        DMPJavaScriptSourceURL.appLogic(this.app.appConfig.appId, packageName)
      )
    }
  }
}
