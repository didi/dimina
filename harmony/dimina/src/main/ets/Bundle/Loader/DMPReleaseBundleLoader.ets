import { DMPBundleLoader } from './DMPBundleLoader';
import { DMPBundleInstallConfig } from '../Model/DMPBundleInstallConfig';
import { DMPBundleLoadInfo } from '../Model/DMPBundleLoadInfo';
import bundleManager from '@ohos.bundle.bundleManager';
import { DMPPreference } from '../../Utils/DMPPreference';
import { DMPFileManager } from '../Util/DMPFileManager';
import { DMJSAppBundleConfig } from '../Model/DMJSAppBundleConfig';
import { DMPJSSdkBundleConfig } from '../Model/DMPJSSdkBundleConfig';
import { DMPContextUtils } from '../../Utils/DMPContextUtils';
import { DMPRawFileUtils } from '../../Utils/DMPRawFileUtils';
import { DMPStringUtils } from '../../Utils/DMPStringUtils';
import { DMPLogger } from '../../EventTrack/DMPLogger';
import { Tags } from '../../EventTrack/Tags';
import { ErrorCode } from '../Model/DMPBundleError';
import { DMPAppManager } from '../../DApp/DMPAppManager';
import { DMPApp } from '../../DApp/DMPApp';
import { DMPMap } from '../../Utils/DMPMap';
import { DMPTextUtils } from '../../Utils/DMPTextUtils';
import { DialogManager } from '../../Bridges/Widget/DialogManager';
import { EngineStatus } from '../../DApp/utils/DMPStatusMonitor';

export class DMPReleaseBundleLoader implements DMPBundleLoader {
  //文件管理
  private fileManager: DMPFileManager = DMPFileManager.sharedInstance();
  installConfig: DMPBundleInstallConfig | null = null;
  installBundleInfo: DMPBundleLoadInfo | null = null;
  _launchBundleReady: ((config: DMPBundleLoadInfo) => void) | null = null;
  _loadError: ((code: number, errMsg: string) => void) | null = null;
  //启动包准备好
  private isLaunchBundleReady = false
  private app: DMPApp

  constructor(app: DMPApp) {
    this.app = app;
  }

  private isDebugMode(): boolean {
    return this.app.appConfig.isDebugMode || DMPContextUtils.debugMode;
  }

  async install(installConfig: DMPBundleInstallConfig, launchBundleReady: (config: DMPBundleLoadInfo) => void,
    loadComplete?: (config: DMPBundleLoadInfo) => void,
    loadError?: (code: number, errMsg: string) => void): Promise<DMPBundleLoadInfo> {
    DMPLogger.i(Tags.BUNDLE, "ReleaseBundleLoader install start");
    this.isLaunchBundleReady = false;
    this._launchBundleReady = launchBundleReady;
    this._loadError = this.loadErrorProxy(loadError)
    let bundleLoadInfo = new DMPBundleLoadInfo();
    this.installBundleInfo = bundleLoadInfo;
    bundleLoadInfo.appId = installConfig.appId
    bundleLoadInfo.appIndex = installConfig.appIndex;
    this.installConfig = installConfig;
    this.fileManager.initRootDir(this.installConfig!.appId)
    await this.loadAppVersion(bundleLoadInfo);
    await this.loadLocalPackage(bundleLoadInfo);

    this.clearHistoryVersion(bundleLoadInfo)
    DMPLogger.i(Tags.BUNDLE, "ReleaseBundleLoader install end");
    return bundleLoadInfo;
  }

  private loadErrorProxy(loadError: ((code: number, errMsg: string) => void) | undefined): ((code: number,
    errMsg: string) => void) | null {
    return (code: number, msg: string) => {
      loadError?.(code, msg);
    };
  }

  showLaunchFailDialog(msg: string) {
    DialogManager.getInstance().showDialog({
      title: "提示",
      confirmText: "重试",
      content: msg,
      showCancel: true,
      cancelText: '取消',
      cancelColor: "#000000",
      confirmColor: '#576B95',
      cancel: () => {
        this.app.engineStatus.setStatus(EngineStatus.STOP)
      },
      confirm: () => {
        this.app.engineStatus.setStatus(EngineStatus.STOP)
        this.app.startPackageLoader(DMPContextUtils.getUIAbilityContext())
      }
    })
  }

  async loadAppVersion(bundleLoadInfo: DMPBundleLoadInfo) {
    DMPLogger.i(Tags.BUNDLE, "加载应用版本");
    let bundle = await bundleManager.getBundleInfoForSelf(bundleManager.BundleFlag.GET_BUNDLE_INFO_WITH_APPLICATION);
    bundleLoadInfo.appVersionName = bundle.versionName;
    bundleLoadInfo.appVersionCode = bundle.versionCode;
    bundleLoadInfo.cacheVersionName =
      await DMPPreference.getInstance().get<string>(bundleLoadInfo.appId + "_versionName", "1.0.0")
    bundleLoadInfo.cacheVersionCode =
      await DMPPreference.getInstance().get<number>(bundleLoadInfo.appId + "_versionCode", 0)
    DMPLogger.i(Tags.BUNDLE,
      `appVersionName=${bundleLoadInfo.appVersionName} appVersionCode=${bundleLoadInfo.appVersionCode}`);
    DMPLogger.i(Tags.BUNDLE,
      `cacheVersionName=${bundleLoadInfo.cacheVersionName} cacheVersionCode=${bundleLoadInfo.cacheVersionCode}`);
  }

  //加载底包
  async loadLocalPackage(bundleLoadInfo: DMPBundleLoadInfo) {
    try {
      if (bundleLoadInfo.isAppUpdate() || this.isDebugMode()) {
        DMPLogger.i(Tags.LOAD_LOCAL_BUNDLE, '应用有更新或处于调试模式');
        //加载本地配置
        this.loadLocalBundleConfig(bundleLoadInfo);
        //安装jsApp本地包
        await this.installLocalJsAppBundle(bundleLoadInfo);
        //安装jsSdk本地包
        await this.installLocalJSSDKBundle(bundleLoadInfo);
        //安装成功以后，存储version
        DMPPreference.getInstance().put(bundleLoadInfo.appId + "_versionName", bundleLoadInfo.appVersionName!)
        DMPPreference.getInstance().put(bundleLoadInfo.appId + "_versionCode", bundleLoadInfo.appVersionCode!)
        this.tryLaunchApp(bundleLoadInfo);
      } else {
        DMPLogger.i(Tags.BUNDLE, "加载缓存包")
        this.loadCacheConfig(bundleLoadInfo);
        this.tryLaunchApp(bundleLoadInfo);
      }
    } catch (e) {
      this.handleException(Tags.LOAD_LOCAL_BUNDLE, ErrorCode.LOAD_LOCAL_BUNDLE_FAILED, e);
    }
  }

  private loadCacheConfig(bundleLoadInfo: DMPBundleLoadInfo) {
    try {
      let cacheJSAppConfig = this.fileManager.loadJSAppConfig(bundleLoadInfo.appId);
      let cacheJSSdkConfig = this.fileManager.loadJSSdkConfig();
      bundleLoadInfo.cacheJSAppBundleConfig = DMJSAppBundleConfig.fromJson(cacheJSAppConfig);
      bundleLoadInfo.cacheJSSdkBundleConfig = DMPJSSdkBundleConfig.fromJson(cacheJSSdkConfig);
    } catch (e) {
      this.handleException(Tags.LOAD_CACHE_CONFIG, ErrorCode.LOAD_CACHE_CONFIG_FAILED, e);
    }
  }

  private tryLaunchApp(bundleLoadInfo: DMPBundleLoadInfo) {
    try {
      DMPLogger.i(Tags.BUNDLE, '尝试启动小程序');
      if (this._launchBundleReady == null) {
        DMPLogger.i(Tags.BUNDLE, '小程序已启动');
      } else if (!this.checkCacheConfigExist(bundleLoadInfo)) {
        DMPLogger.e(Tags.BUNDLE, '小程序配置不完整不允许启动');
      } else {
        DMPLogger.i(Tags.BUNDLE, '启动包已准备好,确认可以启动');
        DMPLogger.i(Tags.BUNDLE,
          '启动配置：jsApp:versionCode=' + bundleLoadInfo.cacheJSAppBundleConfig?.versionCode + " versionName=" +
            bundleLoadInfo.cacheJSAppBundleConfig?.versionName);
        DMPLogger.i(Tags.BUNDLE,
          '启动配置：jsSdk:versionCode=' + bundleLoadInfo.cacheJSSdkBundleConfig?.versionCode + " versionName=" +
            bundleLoadInfo.cacheJSSdkBundleConfig?.versionName);
        this._launchBundleReady(bundleLoadInfo);
        this._launchBundleReady = null;
        this.isLaunchBundleReady = true;
        bundleLoadInfo.currentJsAppBundleConfig = bundleLoadInfo.cacheJSAppBundleConfig
        bundleLoadInfo.currentJsSdkBundleConfig = bundleLoadInfo.cacheJSSdkBundleConfig
      }
    } catch (e) {
      this.handleException(Tags.LAUNCH, ErrorCode.LAUNCH_FAILED, e)
    }
  }

  private checkCacheConfigExist(bundleLoadInfo: DMPBundleLoadInfo): boolean {
    return bundleLoadInfo.cacheJSAppBundleConfig != null && bundleLoadInfo.cacheJSSdkBundleConfig != null;
  }

  private async installLocalJSSDKBundle(bundleLoadInfo: DMPBundleLoadInfo) {
    if (bundleLoadInfo.localJSSdkBundleConfig != null) {
      let cacheJSSdkConfig = this.fileManager.loadJSSdkConfig();
      bundleLoadInfo.cacheJSSdkBundleConfig = DMPJSSdkBundleConfig.fromJson(cacheJSSdkConfig);
      if (this.isDebugMode()
        || bundleLoadInfo.cacheJSSdkBundleConfig == null
        || bundleLoadInfo.localJSSdkBundleConfig.versionCode > bundleLoadInfo.cacheJSSdkBundleConfig.versionCode) {
        await this.fileManager.copyJSSDKAndUnZip(`${bundleLoadInfo.localJSSdkBundleConfig.versionCode}`);
        DMPLogger.i(Tags.BUNDLE, '复制jsSdk完成');
        bundleLoadInfo.cacheJSSdkBundleConfig = bundleLoadInfo.localJSSdkBundleConfig;
      } else {
        DMPLogger.i(Tags.BUNDLE, 'JsSdk已经是最新版本');
      }
    }
  }

  private async installLocalJsAppBundle(bundleLoadInfo: DMPBundleLoadInfo) {

    if (bundleLoadInfo.localJSAppBundleConfig != null) {
      let cacheJSAppConfig = this.fileManager.loadJSAppConfig(bundleLoadInfo.appId);
      bundleLoadInfo.cacheJSAppBundleConfig = DMJSAppBundleConfig.fromJson(cacheJSAppConfig);
      if (this.isDebugMode()
        || bundleLoadInfo.cacheJSAppBundleConfig == null
        || bundleLoadInfo.localJSAppBundleConfig.versionCode > bundleLoadInfo.cacheJSAppBundleConfig.versionCode) {
        await this.fileManager.copyJSAppAndUnZip(this.installConfig!.appId,
          `${bundleLoadInfo.localJSAppBundleConfig.versionCode}`);
        bundleLoadInfo.cacheJSAppBundleConfig = bundleLoadInfo.localJSAppBundleConfig;
        DMPLogger.i(Tags.LOAD_LOCAL_BUNDLE, '复制jsApp底包完成');
      } else {
        DMPLogger.i(Tags.LOAD_LOCAL_BUNDLE, 'jsApp缓存版本已是最新版');
      }
    }
    if (bundleLoadInfo.localJSAppBundleConfig == null) {
      DMPLogger.i(Tags.LOAD_LOCAL_BUNDLE, '无底包模式');
    }
  }


  private loadLocalBundleConfig(bundleLoadInfo: DMPBundleLoadInfo) {
    let localJSAppConfigJson = DMPRawFileUtils.loadFile(DMPContextUtils.getUIAbilityContext(),
      `jsapp/${this.installConfig!.appId}/config.json`);
    if (DMPStringUtils.isNotEmpty(localJSAppConfigJson)) {
      bundleLoadInfo.localJSAppBundleConfig =
        DMJSAppBundleConfig.fromJson(DMPMap.createFromString(localJSAppConfigJson));
    }
    let localJSSdkConfigJson =
      DMPRawFileUtils.loadFile(DMPContextUtils.getUIAbilityContext(), 'jssdk/config.json');
    if (DMPStringUtils.isNotEmpty(localJSSdkConfigJson)) {
      bundleLoadInfo.localJSSdkBundleConfig =
        DMPJSSdkBundleConfig.fromJson(DMPMap.createFromString(localJSSdkConfigJson));
    }
    DMPLogger.i(Tags.LOAD_LOCAL_BUNDLE, "loadLocalBundleConfig complete")
  }

  //清理历史版本
  async clearHistoryVersion(bundleLoadInfo: DMPBundleLoadInfo) {
    DMPLogger.i(Tags.BUNDLE, "清理历史版本")
    if (bundleLoadInfo.cacheJSAppBundleConfig != null) {
      await this.fileManager.clearJSAppHistoryBundle(bundleLoadInfo);
    }
    if (bundleLoadInfo.cacheJSSdkBundleConfig != null) {
      await this.fileManager.clearJSSdkHistoryBundle(bundleLoadInfo);
    }
  }

  waitLaunchReady(launchReady: (config: DMPBundleLoadInfo) => void) {
    this._launchBundleReady = launchReady;

  }

  waitLoadError(code: number, errMsg: string) {
    this._loadError!!(code, errMsg)
    if (this.isLaunchBundleReady) {
      this.onUpdateFailed()
    }
  }

  async requestModuleService(module: string): Promise<string> {
    let data = this.readModuleFileToString(module, 'logic.js');
    return data;
  }

  private readModuleFileToString(module: string, fileName: string) {
    let filePath: string = this.readModuleFilePath(module, fileName);
    // DMPLogger.d(Tags.LOAD_LOCAL_BUNDLE, "filePath=" + filePath)
    let data = this.fileManager.readFileToText(filePath);
    return data;
  }

  private readModuleFilePath(module: string, fileName: string) {
    const appId = this.installBundleInfo?.appId!;
    const code = this.installBundleInfo?.cacheJSAppBundleConfig?.versionCode!;
    const dir = this.fileManager.getJSAppVersionDir(appId, code.toString());
    let filePath: string;
    if (module === "/" || module === "") {
      filePath = `${dir}/${fileName}`;
    } else {
      filePath = `${dir}/${module}/${fileName}`;
    }
    return filePath;
  }

  async requestServiceJsUri(): Promise<string> {
    DMPLogger.i(Tags.LAUNCH, "requestMainJsUri start")
    const version = this.installBundleInfo?.cacheJSSdkBundleConfig?.versionCode!;
    const dir = this.fileManager.getJSSdkVersionDevDir(`${version}`);
    const path: string = `${dir}/assets/service.js`;
    DMPLogger.i(Tags.LAUNCH, "requestMainJsUri end")
    return path;
  }

  async requestLogicJsUri(): Promise<string> {
    DMPLogger.i(Tags.LAUNCH, "requestLogicJsUri start")
    let path = this.readModuleFilePath('main', 'logic.js')
    DMPLogger.i(Tags.LAUNCH, "requestLogicJsUri end")
    return path;
  }

  async requestConfigFile(): Promise<string> {
    DMPLogger.i(Tags.LAUNCH, "requestConfigFile start")
    let data = this.readModuleFileToString('main', 'app-config.json');
    if (DMPTextUtils.isEmpty(data)) {
      DMPLogger.e(Tags.LAUNCH, "request config is null")
    }
    DMPLogger.i(Tags.LAUNCH, "requestConfigFile end")
    return data
  }

  //获取当前jsApp 目录
  getJsAppDir(): string {
    const appId = this.installBundleInfo!.appId;
    const code = this.installBundleInfo?.currentJsAppBundleConfig?.versionCode!;
    return DMPFileManager.sharedInstance().getJSAppVersionDir(appId, code.toString());
  }

  //获取当前jsApp 版本
  getJsAppVersion(): string {
    return this.installBundleInfo?.currentJsAppBundleConfig?.versionCode?.toString()!;
  }

  //获取当前jssdk 目录
  getJSSdkDir(): string {
    const version = this.installBundleInfo?.currentJsSdkBundleConfig?.versionCode!;
    return DMPFileManager.sharedInstance().getJSSdkVersionDevDir(`${version}`);
  }

  //小程序根目录
  getAppRootDir(): string {
    return this.fileManager.getJSAppDir(this.installBundleInfo!.appId)
  }

  private onUpdateFailed() {
    DMPLogger.d(Tags.LOAD_REMOTE_BUNDLE, "通知小程序获取最新版本失败");
    let param: DMPMap = new DMPMap()
    param.set('event', 'updatefail');
    this.onUpdateManagerCall('onUpdateStatusChange', param)
  }

  private onUpdateManagerCall(method: string, arg: DMPMap) {
    // 需要移交给APP去执行
    const app = DMPAppManager.sharedInstance().getApp(this.installConfig!.appIndex)
    if (app) {
      app.onUpdateManagerCall(method, arg)
    }
  }

  private handleException(tag: string, errCode: number, e: object) {
    const errMsg: string = e.toString();
    DMPLogger.e(tag, `errCode :${errCode}, errMsg :${errMsg}`);
    this.waitLoadError(errCode, errMsg);
  }
}

