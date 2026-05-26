import { DMPContainerBridgesModule } from './DMPContainerBridgesModule';
import { DMPBridgeCallback } from './DMPTSUtil';
import { DMPLogger } from '../EventTrack/DMPLogger';
import batteryInfo from '@ohos.batteryInfo';
import deviceInfo from '@ohos.deviceInfo';
import { DMPDeviceUtil } from '../Utils/DMPDeviceUtils';
import { bundleManager, ConfigurationConstant, common } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { DMPMap } from '../Utils/DMPMap';
import BuildProfile from '../../../../BuildProfile';
import { access } from '@kit.ConnectivityKit';
import { i18n } from '@kit.LocalizationKit';

export class DMPContainerBridgesModuleSystem extends DMPContainerBridgesModule {
  private bundleInfo?: bundleManager.BundleInfo
  private cachedResult?: DMPMap = undefined;
  private cacheTimestamp = 0;

  getExportMethods(): string[] {
    return ['getSystemInfoSync', 'getEnv', 'getSystemInfoAsync', 'getAccountInfoSync', 'getSystemInfo',
      'getDiminaCurStackPages', 'getSystemSetting', 'getWindowInfo', 'getAppBaseInfo'];
  }

  getWindowInfo(data: DMPMap, callback: DMPBridgeCallback) {
    const windowInfo = DMPDeviceUtil.getSafeAreaAndDisplayWHSync()
    this.invokeSuccessCallback(callback, windowInfo)
    return windowInfo;
  }

  getDiminaCurStackPages(data: DMPMap, callback: DMPBridgeCallback) {
    const list = this.app.navigatorManager.getCurNavigator()?.getNavigator().stacks.data;
    let pages = Array<Object>();
    if (list) {
      for (let record of list) {
        const pageInfo = new PageInfo();
        pageInfo.route = record.pagePath
        pageInfo.id = record.webViewId
        pageInfo.query = record.params?.get('query')
        pages.push(pageInfo)
      }
    }
    return pages
  }

  getEnv(data: DMPMap, callback: DMPBridgeCallback) {
    this.invokeSuccessCallback(callback, new DMPMap({ 'miniprogram': true }));
  }

  getSystemSetting(data: DMPMap, callback: DMPBridgeCallback) {
    try {
      let state = access.getState();
      console.error(`let state = access.getState(): ${state}`);

      return new DMPMap({
        bluetoothEnabled: state === 0,
        locationEnabled: true,
        wifiEnabled: true,
        deviceOrientation: 'portrait'
      })

    } catch (err) {
      console.error('errCode: ' + (err as BusinessError).code + ', errMessage: ' + (err as BusinessError).message);
      return new DMPMap();
    }
  }

  getAppBaseInfo(data: DMPMap, callback: DMPBridgeCallback) {
    const info = this.systemInfo()
    const keys = ['SDKVersion', 'enableDebug', 'host', 'language', 'version',
      'theme', 'fontSizeScaleFactor', 'fontSizeSetting']
    const result = new DMPMap()
    for (const key of keys) {
      const value: string | number | boolean | object | undefined = info.get(key)
      if (value !== undefined) {
        result.set(key, value)
      }
    }
    return result
  }

  getSystemInfoSync(data: DMPMap, callback: DMPBridgeCallback) {
    const currentTime = Date.now();
    // 检查缓存是否有效（10秒）
    if (this.cachedResult && (currentTime - this.cacheTimestamp < 10000)) {
      return this.cachedResult;
    }
    // 如果缓存无效，则重新获取系统信息
    const result = this.systemInfo();
    // 更新缓存
    this.cachedResult = result;
    this.cacheTimestamp = currentTime;

    return result;
  }

  getSystemInfoAsync(data: DMPMap, callback: DMPBridgeCallback) {
    this.invokeSuccessCallback(callback, this.systemInfo());
  }

  getSystemInfo(data: DMPMap, callback: DMPBridgeCallback) {
    const info = this.systemInfo()
    this.invokeSuccessCallback(callback, info);
    return info;
  }

  getAccountInfoSync(data: DMPMap, callback: DMPBridgeCallback) {
    if (this.app) {
      return new DMPMap({
        'miniProgram': {
          'envVersion': 'release',
          'appId': this.app.appConfig?.appId,
          'version': this.app.bundleManager.getBundleInfo().currentJsAppBundleConfig?.versionName
        }
      })
    }
    return new DMPMap({ 'miniProgram': { 'envVersion': 'release' } })
  }

  private systemInfo(): DMPMap {
    let result: DMPMap = new DMPMap();

    result.set('errMsg', 'getSystemInfo:ok');

    let batterySOCInfo: number = batteryInfo.batterySOC;
    result.set('batteryLevel', batterySOCInfo);

    // "brand": "HUAWEI",
    let brand: string = deviceInfo.brand;
    result.set('brand', brand);

    // "model": "HUAWEI Mate 60 Pro",
    let marketName: string = deviceInfo.marketName;
    result.set('model', marketName);

    // "system": "iOS 10.0.1",
    let osFullName: string = deviceInfo.osFullName;
    result.set('system', osFullName);

    // 小程序助手校验这个platform 暂时修改成android
    result.set('platform', 'ohos');

    // "pixelRatio": 3.25, 根据 px2vp() 推算出来
    result.set('pixelRatio', 3.25);
    if (!this.bundleInfo) {
      this.bundleInfo =
        bundleManager.getBundleInfoForSelfSync(bundleManager.BundleFlag.GET_BUNDLE_INFO_WITH_APPLICATION)
    }
    //宿主App 版本
    result.set('version', this.bundleInfo.versionName);

    //星河sdk版本
    result.set('SDKVersion', BuildProfile.HAR_VERSION);
    result.set('enableDebug', this.app.appConfig.isDebugMode);
    result.set('debugEnv', this.app.appConfig.isDebugMode ? 1 : 0)

    // language: 微信客户端设置的语言
    const locale = i18n.System.getSystemLocale()
    result.set('language', locale)

    // theme: 系统当前主题
    try {
      const uiContext = getContext(this) as common.UIAbilityContext
      const colorMode = uiContext.config.colorMode
      result.set('theme', colorMode === ConfigurationConstant.ColorMode.COLOR_MODE_DARK ? 'dark' : 'light')
    } catch (e) {
      result.set('theme', 'light')
    }

    // host: 宿主信息
    result.set('host', { appId: this.app.appConfig.appId })

    // font settings
    try {
      const uiCtx = getContext(this) as common.UIAbilityContext
      const fontSizeScale: number = uiCtx.config.fontSizeScale ?? 1.0
      result.set('fontSizeScaleFactor', fontSizeScale)
      result.set('fontSizeSetting', Math.round(16 * fontSizeScale))
    } catch (e) {
      result.set('fontSizeScaleFactor', 1.0)
      result.set('fontSizeSetting', 16)
    }
    try {

      result.set('appid', this.app.bundleManager.getBundleInfo().appId)
      result.set('jssdkid', "")
      result.set('jssdkVersion', this.app.bundleManager.getBundleInfo().currentJsSdkBundleConfig?.versionName)
      result.set('sdkVersionName', this.app.bundleManager.getBundleInfo().currentJsSdkBundleConfig?.versionName)
      result.set('sdkVersionCode', this.app.bundleManager.getBundleInfo().currentJsSdkBundleConfig?.versionCode)

      result.set('appVersion', this.app.bundleManager.getBundleInfo().currentJsAppBundleConfig?.versionName)
      result.set('appVersionName', this.app.bundleManager.getBundleInfo().currentJsAppBundleConfig?.versionName)
      result.set('appVersionCode', this.app.bundleManager.getBundleInfo().currentJsAppBundleConfig?.versionCode)

    } catch (e) {
      DMPLogger.e("获取bundle 信息异常")
    }

    result.setAll(DMPDeviceUtil.getSafeAreaAndDisplayWHSync());

    return result;
  }
}

class PageInfo {
  route?: string
  id?: number
  query?: Object
}

