import { DMPMap } from '../../Utils/DMPMap';

// TabBar item configuration
export interface DMPTabBarItem {
  pagePath: string;
  text: string;
  iconPath?: string;
  selectedIconPath?: string;
}

// TabBar configuration
export interface DMPTabBarConfig {
  color: string;
  selectedColor: string;
  backgroundColor: string;
  borderStyle: string;  // "black" or "white"
  list: DMPTabBarItem[];
}

//app-config.json
export class DMPBundleAppConfigNext {
  data: object;
  app: object;
  modules: object;
  pages: string[] | null;
  style: string;
  sitemapLocation: string;
  subPackages: SubPackageConfig[];
  _entryPagePath: string;
  moduleMaps: Map<string, ModuleConfig>
  tabBar?: DMPTabBarConfig;

  constructor(data: object) {
    this.data = data
    this.app = data['app']
    this.modules = data['modules']
    this.moduleMaps = DMPMap.toMap<string, ModuleConfig>(this.modules)

    this.pages = this.app['pages'];
    this.style = this.app['style'];
    this.sitemapLocation = this.app['sitemapLocation'];
    this.subPackages = this.app['subPackages'];
    this._entryPagePath = this.app['entryPagePath'];

    // Parse tabBar config
    if (this.app['tabBar']) {
      const tabBarData: ESObject = this.app['tabBar'] as ESObject;
      if (tabBarData['list'] && (tabBarData['list'] as Array<ESObject>).length > 0) {
        this.tabBar = {
          color: tabBarData['color'] || '#999999',
          selectedColor: tabBarData['selectedColor'] || '#1890ff',
          backgroundColor: tabBarData['backgroundColor'] || '#ffffff',
          borderStyle: tabBarData['borderStyle'] || 'black',
          list: (tabBarData['list'] as Array<ESObject>).map((item: ESObject): DMPTabBarItem => {
            return {
              pagePath: item['pagePath'] as string,
              text: item['text'] as string,
              iconPath: item['iconPath'] as string | undefined,
              selectedIconPath: item['selectedIconPath'] as string | undefined
            };
          })
        };
      }
    }
  }

  public getRootPackage(pagePath: string): string {
    return this.moduleMaps.get(pagePath)?.root ?? "main";
  }

  public isContainsPage(pagePath: string): boolean {
    if (this.moduleMaps.get(pagePath)) {
      return true;
    }
    return false;
  }

  public getModuleConfig(pagePath: string): ModuleConfig | undefined | null {
    return this.moduleMaps.get(pagePath);
  }

  public static fromJsonString(json: string): DMPBundleAppConfigNext | null {
    const dictionary: object = JSON.parse(json);
    let config = new DMPBundleAppConfigNext(dictionary);
    return config;
  }

  get entryPagePath(): string {
    if (!this._entryPagePath || !this._entryPagePath.length) {
      this._entryPagePath = this.pages![0]
    }
    return this._entryPagePath
  }

  set entryPagePath(path: string) {
    this._entryPagePath = path
  }

  getPageConfigNext(pagePath: string): DMPMap {
    const pagePrivateConfig: object = this.modules[pagePath] ?? new Object();
    const appWindowConfig: object = this.app['window'] ?? new Object();

    const mergedConfig = new DMPMap();
    mergedConfig.set('navigationBarTitleText',
      pagePrivateConfig['navigationBarTitleText'] || appWindowConfig['navigationBarTitleText'] || '');
    mergedConfig.set('navigationBarBackgroundColor',
      pagePrivateConfig['navigationBarBackgroundColor'] || appWindowConfig['navigationBarBackgroundColor'] || '#FFFFFF');
    mergedConfig.set('navigationBarTextStyle',
      pagePrivateConfig['navigationBarTextStyle'] || appWindowConfig['navigationBarTextStyle']|| 'black');
    mergedConfig.set('backgroundColor',
      pagePrivateConfig['backgroundColor'] || appWindowConfig['backgroundColor'] || '#fff');
    mergedConfig.set('navigationStyle',
      pagePrivateConfig['navigationStyle'] || appWindowConfig['navigationStyle'] || 'default');
    mergedConfig.set('usingComponents', pagePrivateConfig['usingComponents'] || {});

    return mergedConfig;
  }

  /**
   * Get set of all tabBar page paths
   */
  getTabBarPagePaths(): Set<string> {
    if (!this.tabBar) {
      return new Set<string>();
    }
    return new Set(this.tabBar.list.map(item => item.pagePath));
  }

  /**
   * Check if a page is a tabBar page
   */
  isTabBarPage(pagePath: string): boolean {
    return this.getTabBarPagePaths().has(pagePath);
  }
}


interface SubPackageConfig {
  root: string;
  pages: string[];
}

export interface ModuleConfig {
  root: string;
  navigationBarTitleText: string;

}
