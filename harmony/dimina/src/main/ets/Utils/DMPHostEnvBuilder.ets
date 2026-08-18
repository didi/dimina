import { DMPApp } from '../DApp/DMPApp';
import { DMPDeviceUtil } from './DMPDeviceUtils';
import { DMPMap } from './DMPMap';
import batteryInfo from '@ohos.batteryInfo';
import deviceInfo from '@ohos.deviceInfo';
import { bundleManager, ConfigurationConstant, common } from '@kit.AbilityKit';
import BuildProfile from '../../../../BuildProfile';
import { i18n } from '@kit.LocalizationKit';
import { DMPContextUtils } from './DMPContextUtils';
import { DMPMenuButtonLayout } from './DMPMenuButtonLayout';

export class DMPHostEnvBuilder {
  static buildSnapshot(app: DMPApp): DMPMap {
    const systemInfo: DMPMap = DMPHostEnvBuilder.buildSystemInfo(app)
    const menuRect: DMPMap = DMPMenuButtonLayout.buildFromWindowMetrics(
      DMPDeviceUtil.getSafeAreaAndDisplayWHSync())

    const snapshot: DMPMap = new DMPMap()
    snapshot.set('systemInfo', systemInfo.toJSON())
    snapshot.set('menuRect', menuRect.toJSON())

    return snapshot
  }

  private static buildSystemInfo(app: DMPApp): DMPMap {
    const whData: DMPMap = DMPDeviceUtil.getSafeAreaAndDisplayWHSync()
    let info: bundleManager.BundleInfo | undefined
    try {
      info = bundleManager.getBundleInfoForSelfSync(bundleManager.BundleFlag.GET_BUNDLE_INFO_WITH_APPLICATION)
    } catch (_) {
    }

    // language
    const language: string = i18n.System.getSystemLocale()

    // theme
    let theme: string = 'light'
    try {
      const uiContext = getContext() as common.UIAbilityContext
      if (uiContext.config.colorMode === ConfigurationConstant.ColorMode.COLOR_MODE_DARK) {
        theme = 'dark'
      }
    } catch (_) {
    }

    // font
    let fontSizeScaleFactor: number = 1.0
    try {
      const uiCtx = getContext() as common.UIAbilityContext
      fontSizeScaleFactor = uiCtx.config.fontSizeScale ?? 1.0
    } catch (_) {
    }

    const result: DMPMap = new DMPMap()

    // device
    result.set('brand', deviceInfo.brand)
    result.set('model', deviceInfo.marketName)
    result.set('system', deviceInfo.osFullName)
    result.set('platform', 'ohos')
    result.set('pixelRatio', (whData.get('pixelRatio') as number) ?? 3.25)
    result.set('batteryLevel', batteryInfo.batterySOC)

    // window
    result.set('screenWidth', whData.get('screenWidth') as number)
    result.set('screenHeight', whData.get('screenHeight') as number)
    result.set('windowWidth', whData.get('windowWidth') as number)
    result.set('windowHeight', whData.get('windowHeight') as number)
    result.set('statusBarHeight', whData.get('statusBarHeight') as number)
    const safeAreaData: DMPMap | undefined = whData.get('safeArea') as DMPMap | undefined
    if (safeAreaData) {
      result.set('safeArea', safeAreaData.toJSON())
    }

    // app base info
    result.set('SDKVersion', BuildProfile.HAR_VERSION)
    result.set('version', info?.versionName ?? '')
    result.set('enableDebug', DMPContextUtils.debugMode)
    result.set('language', language)
    result.set('theme', theme)

    const hostInfo: DMPMap = new DMPMap()
    hostInfo.set('appId', app.appConfig.appId)
    result.set('host', hostInfo.toJSON())

    result.set('fontSizeScaleFactor', fontSizeScaleFactor)
    result.set('fontSizeSetting', Math.round(16 * fontSizeScaleFactor))

    return result
  }

}
