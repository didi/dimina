import { common } from '@kit.AbilityKit';
import {
  DMPApp,
  DMPAppConfig,
  DMPAppManager,
  DMPLaunchConfig,
  DMPOpenType
} from '@didi-dimina/dimina';

export class DiminaFlutterHost {
  private static context?: common.UIAbilityContext;
  private static pageInfos?: NavPathStack;
  private static apps: Map<string, DMPApp> = new Map<string, DMPApp>();

  static attach(context: common.UIAbilityContext, pageInfos: NavPathStack): void {
    DiminaFlutterHost.context = context;
    DiminaFlutterHost.pageInfos = pageInfos;
  }

  static async open(
    appId: string,
    name: string,
    path: string,
    updateManifestUrl?: string
  ): Promise<boolean> {
    const context = DiminaFlutterHost.context;
    const pageInfos = DiminaFlutterHost.pageInfos;
    if (!context || !pageInfos || appId.length === 0 || DiminaFlutterHost.apps.has(appId)) {
      return false;
    }

    const appConfig = new DMPAppConfig(name, appId);
    if (updateManifestUrl && updateManifestUrl.length > 0) {
      appConfig.updateManifestUrl = updateManifestUrl;
    }

    const app = DMPAppManager.sharedInstance().appWithConfig(appConfig);
    app.router.init(pageInfos);

    const launchConfig = new DMPLaunchConfig();
    launchConfig.openType = DMPOpenType.NavigateTo;
    if (path.length > 0) {
      launchConfig.appEntryPath = path;
    }
    const accepted = new Promise<boolean>((resolve: (success: boolean) => void): void => {
      launchConfig.completion = (success: boolean): void => {
        if (!success) {
          DiminaFlutterHost.apps.delete(appId);
        }
        resolve(success);
      };
    });

    await app.startPackageLoader(context, launchConfig);
    DiminaFlutterHost.apps.set(appId, app);
    app.launch(launchConfig);
    return accepted;
  }

  static async close(appId: string): Promise<boolean> {
    const app = DiminaFlutterHost.apps.get(appId);
    if (!app) {
      return false;
    }
    await app.closeMiniProgram();
    DiminaFlutterHost.apps.delete(appId);
    return true;
  }
}
