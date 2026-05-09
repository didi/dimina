import { DMPExportModule } from './DMPExportModule';
import { DMPContainerBridgesModuleExt } from './DMPContainerBridgesModule+Ext';
import { DMPExtModuleHandler } from './DMPExtModuleHandler';
import { DMPContainerBridgesModuleActionSheet } from './DMPContainerBridgesModule+ActionSheet';
import { DMPContainerBridgesModulePopUp } from './DMPContainerBridgesModule+Popup';
import { DMPContainerBridgesModuleNavigator } from './DMPContainerBridgesModule+Navigator';
import { DMPContainerBridgesModuleDom } from './DMPContainerBridgesModule+Dom';
import { DMPContainerBridgesModuleWeb } from './DMPContainerBridgesModule+Web';
import { DMPContainerBridgesModuleSystem } from './DMPContainerBridgesModule+System';
import { DMPContainerBridgesModuleAnalytics } from './DMPContainerBridgesModule+Analytics';
import { DMPContainerBridgesModuleComponentAPI } from './DMPContainerBridgesModule+ComponentAPI';
import { DMPContainerBridgesModuleContact } from './DMPContainerBridgesModule+Contact';
import { DMPContainerBridgesModuleShare } from './Share/DMPContainerBridgesModule+Share';
import { DMPContainerBridgesModuleCamera } from './DMPContainerBridgesModule+Camera';
import { DMPContainerBridgesModuleNetwork } from './Network/DMPContainerBridgesModule+Network';
import { DMPContainerBridgesModuleStorage } from './DMPContainerBridgesModule+Storage';
import { DMPContainerBridgesModuleMenu } from './DMPContainerBridgesModule+Menu';
import { DMPContainerBridgesModuleToast } from './DMPContainerBridgesModule+Toast';
import { DMPContainerBridgesModuleImage } from './DMPContainerBridgesModule+Image';
import { DMPContainerBridgesModuleVibrate } from './DMPContainerBridgesModule+Vibrate';
import { DMPContainerBridgesModuleCallPhone } from './DMPContainerBridgesModule+CallPhone';
import { DMPContainerBridgesModuleAudio } from './Audio/DMPContainerBridgesModule+Audio';
import { DMPContainerBridgesModuleClipBoard } from './DMPContainerBridgesModule+Clipboard';
import { DMPContainerBridgesModuleOpenSetting } from './DMPContainerBridgesModule+OpenSetting';
import { DMPContainerBridgesModuleScanCode } from './DMPContainerBridgesModule+ScanQRCode';
import DMPContainerBridgesModuleLoading from './DMPContainerBridgesModule+Loading';
import { DMPContainerBridgesModulePrivacy } from './DMPContainerBridgesModule+Privacy';
import { DMPContainerBridgesModuleScroll } from './DMPContainerBridgesModule+Scroll';
import { DMPContainerBridgesModuleMisc } from './DMPContainerBridgesModule+Misc';
import { DMPModuleManager } from './DMPModuleManager';
import { DMPContainerBridgesModuleNavigationBar } from './DMPContainerBridgesModule+NavigationBar';
import { DMPContainerBridgesModuleNavigateToMiniProgram } from './DMPContainerBridgesModule+NavigateToMiniProgram';
import { DMPApp } from '../DApp/DMPApp';
import { DMPContainerBridgesModuleBluetooth } from './DMPContainerBridgesModule+Bluetooth';
import { DMPContainerBridgesModuleVideo } from './DMPContainerBridgesModule+Video';


export class DMPAppModuleManager extends DMPModuleManager {
  exportModules: Map<string, DMPExportModule>;
  app: DMPApp;

  /** 宿主注册的第三方扩展模块表 */
  private extModules: Map<string, DMPExtModuleHandler> = new Map();
  /** 懒创建的 Ext Bridge 模块实例 */
  private extBridgeModule: DMPContainerBridgesModuleExt | null = null;

  registerExtModule(moduleName: string, handler: DMPExtModuleHandler): void {
    this.extModules.set(moduleName, handler);
    // 若已有实例则直接更新模块表（extModules 是同一引用，自动生效）
    if (!this.extBridgeModule) {
      this.extBridgeModule = new DMPContainerBridgesModuleExt(this.app, this.extModules);
    }
  }

  getExtBridgeModule(): DMPContainerBridgesModuleExt | null {
    return this.extBridgeModule;
  }

  constructor(app: DMPApp) {
    super();
    this.app = app;
    this.exportModules = new Map();
    const module = new DMPExportModule('DMPContainerBridgesModule', 'DMPContainerBridgesModule')
    this.exportModules['DMPContainerBridgesModule'] = module

    this.registerModule(new DMPContainerBridgesModuleMisc(app))
    this.registerModule(new DMPContainerBridgesModuleActionSheet(app))
    this.registerModule(new DMPContainerBridgesModuleBluetooth(app))
    this.registerModule(new DMPContainerBridgesModuleComponentAPI(app))
    this.registerModule(new DMPContainerBridgesModulePopUp(app))
    this.registerModule(new DMPContainerBridgesModuleDom(app))
    this.registerModule(new DMPContainerBridgesModuleNavigator(app))
    this.registerModule(new DMPContainerBridgesModuleWeb(app))
    this.registerModule(new DMPContainerBridgesModuleSystem(app))

    this.registerModule(new DMPContainerBridgesModuleAnalytics(app))
    this.registerModule(new DMPContainerBridgesModuleContact(app))

    this.registerModule(new DMPContainerBridgesModuleShare(app))
    this.registerModule(new DMPContainerBridgesModuleCamera(app))
    this.registerModule(new DMPContainerBridgesModuleNetwork(app))
    this.registerModule(new DMPContainerBridgesModuleStorage(app))

    this.registerModule(new DMPContainerBridgesModuleMenu(app))
    this.registerModule(new DMPContainerBridgesModuleImage(app))
    this.registerModule(new DMPContainerBridgesModuleVideo(app))
    this.registerModule(new DMPContainerBridgesModuleToast(app))
    this.registerModule(new DMPContainerBridgesModuleVibrate(app))
    this.registerModule(new DMPContainerBridgesModuleCallPhone(app))
    this.registerModule(new DMPContainerBridgesModuleAudio(app))
    this.registerModule(new DMPContainerBridgesModuleClipBoard(app))
    this.registerModule(new DMPContainerBridgesModuleOpenSetting(app))

    this.registerModule(new DMPContainerBridgesModuleScanCode(app))
    this.registerModule(new DMPContainerBridgesModuleLoading(app))
    this.registerModule(new DMPContainerBridgesModulePrivacy(app))
    this.registerModule(new DMPContainerBridgesModuleScroll(app))
    this.registerModule(new DMPContainerBridgesModuleNavigationBar(app))
    this.registerModule(new DMPContainerBridgesModuleNavigateToMiniProgram(app))
  }
}






