
import { DMPMapConfig } from '../../Bridges/Map/DMPMapConfig';
import { DMPSafetyConfig } from '../../Bridges/SafetyShield/DMPSafetyConfig';
import { DMPPageRecord } from '../../Navigator/DMPPageRecord';
import { DMPMap } from '../../Utils/DMPMap';
import { BusinessError } from '@kit.BasicServicesKit';
import { DomReadyListener, PopListener } from '../../Navigator/DMPNavigatorManager';

export enum DMPOpenType {
  NavigateTo = 0,
  Insert,
  Replace
}

export enum WebViewDefaultId {
  InitId = -3
}

export enum DMPScene {
  fromMainEntry = 1001,
  fromMiniProgram = 1037
}

export class DMPLaunchStackConfig {
  appEntryPath?: string;
  query?: DMPMap;
}

export class DMPLaunchConfig {
  //启动页面类型
  openType?: DMPOpenType;
  //启动页面路径
  appEntryPath?: string;
  //传递给页面参数
  query?: DMPMap;
  launchAnimated?: boolean;
  isHoldMode?: boolean;
  isRelaunch?: boolean;
  appOpenUrl?: string;
  completion?: (success: boolean, error?: BusinessError) => void;
  // 底部导航栏预留的安全距离
  bottomSafeArea: boolean = true;
  // 自定义启动容器
  customLaunchPageCallBack?: (record: DMPPageRecord, path: String, stackId: number, isRelaunch?: boolean) => void;
  firstDomReadyListener?: () => void;
  //销毁监听
  popListener?: PopListener;
}

export class DMPCustomConfig {
  mapConfig?: DMPMapConfig
  safetyConfig?: DMPSafetyConfig
}

