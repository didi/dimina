import { DMPApp } from '../DApp/DMPApp'
import { DMPLaunchType } from '../DApp/config/DMPAppConfig'
import { DMPContainerBridgesModule } from './DMPContainerBridgesModule'

import { DMPBridgeCallback } from './DMPTSUtil'
import { DMPFileManager } from '../Bundle/Util/DMPFileManager'
import { DataTransformer } from '../Utils/DataTransformer'
import { DMPLogger } from '../EventTrack/DMPLogger'
import { DMPMap } from '../Utils/DMPMap'
import { Tags } from '../EventTrack/Tags'

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

  navigateBack(data: DMPMap, callback: DMPBridgeCallback) {
    const navigator = this.app.navigatorManager.getCurNavigator()
    if (navigator) {
      let delta: number = data.getNumber('delta') ?? 1
      navigator.navigateBack(delta)
    }
    this.invokeSuccessCallback(callback, null);
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
    app.updateApp()
  }

  private async exeJsLogicScript(packageName: string) {
    if (packageName != 'main') {
      DMPLogger.d(Tags.SUB_PKG_MANAGER, "执行逻辑层 package=" + packageName)
      let data = await this.app.bundleManager.bundleLoader.requestModuleService(packageName)
      this.app.service.executeScript(data)
    }
  }
}

