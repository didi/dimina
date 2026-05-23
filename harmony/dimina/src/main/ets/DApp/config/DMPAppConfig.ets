
export enum DMPLaunchType {
  OnLine = 0,
  GiftUrl = 1,
  LocalBuild = 2,
  DebugUrl = 3,
}

const launchTypeMap = new Map<string, DMPLaunchType>([
  ["online", DMPLaunchType.OnLine],
  ["gift", DMPLaunchType.GiftUrl],
  ["local", DMPLaunchType.LocalBuild],
  ["debug", DMPLaunchType.DebugUrl],
  ["ip", DMPLaunchType.DebugUrl],
]);

export function getLaunchTypeFromString(input: string): DMPLaunchType {
  const lowerInput = input.toLowerCase();
  return launchTypeMap.get(lowerInput) ?? DMPLaunchType.OnLine;
}

export class DMPAppConfig {
  appName: string = ''
  appCode?: string;
  appId: string = ''
  appBundlePath?: string;
  userAgent?: string;
  ravenID?: string;
  packageConfigBusinessParams?: Map<string, string>;
  launchAppType: DMPLaunchType = DMPLaunchType.OnLine;
  //starBox立即启动,不会读取设置的启动包
  launchImmediate: boolean = false;
  forceUpdateAppVersion?: string;
  forceUpdateTimeout: number = 0;
  isPreloadApp: boolean = false;
  preloadPagePath?: string;
  debugJssdkVersion?: string;
  debugUrl?: string;
  giftUrl?: string;
  debugGiftForceDownload: boolean = false;
  buildBundlePath?: string;
  updateManifestUrl?: string;
  debugInterceptJSCore?: boolean;
  debugInterceptWebview?: boolean;
  //小程序在返回的时候不会被关闭
  isKeepAlive = false;
  //目前打包模式都是debug, 因此在上线时需要手动修改
  isDebugMode = false;

  constructor(appName: string, appId: string) {
    this.appName = appName;
    this.appId = appId;
  }
}
