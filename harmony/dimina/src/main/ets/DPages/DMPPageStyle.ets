import { DMPAppManager } from '../DApp/DMPAppManager'
import { DMPLogger } from '../EventTrack/DMPLogger';
import { DMPMap } from '../Utils/DMPMap';

@Observed
export class DMPPageStyle {
  private _bottomSafeArea: number;
  private _navStyle: DMPMap;
  private appIndex: number;

  constructor(navStyle: DMPMap, appIndex: number) {
    this.appIndex = appIndex;
    this._navStyle = navStyle
    this._bottomSafeArea = DMPAppManager.sharedInstance().getApp(this.appIndex)?.getWindowBottomSafeArea() ?? 0
  }

  get navStyle(): DMPMap {
    return this._navStyle;
  }

  set navStyle(value: DMPMap) {
    this._navStyle = value;
    this._bottomSafeArea = DMPAppManager.sharedInstance().getApp(this.appIndex)?.getWindowBottomSafeArea() ?? 0;
  }

  public getBottomSafeArea(): number {
    return this._bottomSafeArea;
  }

  getBackGroundColor(): string {
    if (this.navStyle.get('backgroundColor')) {
      return this.navStyle.get('backgroundColor');
    }
    if (this.navStyle.get('window') && this.navStyle.get('window').get('backgroundColor')) {
      return this.navStyle.get('window').get('backgroundColor');
    }
    return '#ffffff';
  }

  isHideTitleBar(webViewId: number): boolean {
    if (this.navStyle.get('isHide') && this.navStyle.get('isHide') === true) {
      return true;
    }
    return this.isDiminaAppPage(DMPAppManager.sharedInstance()
      .getApp(this.appIndex)?.navigatorManager
      .getPageRecordById(webViewId)?.pagePath ?? '') && this.isCustomPage();
  }

  isDiminaAppPage(url: string): boolean {
    return DMPAppManager.sharedInstance()
      .getApp(this.appIndex)?.bundleManager.getJsAppModuleConfig()?.isContainsPage(url) ?? false;
  }

  isStatusBarDarkMode(): boolean {
    if (this.navStyle.get('navigationBarTextStyle')) {
      const isDark = 'black' === this.navStyle.get('navigationBarTextStyle') ||
        'dark' === this.navStyle.get('navigationBarTextStyle');
      DMPLogger.d("isStatusBarDarkMode isDark=" + isDark, this.navStyle.get('navigationBarTextStyle'),
        this.navStyle.get('navigationBarTextStyle'));
      return isDark;
    }
    if (this.navStyle.get('window') && this.navStyle.get('window').get('navigationBarTextStyle')) {
      return 'black' === this.navStyle.get('window').get('navigationBarTextStyle') ||
        'dark' === this.navStyle.get('window').get('navigationBarTextStyle');
    }
    return false;
  }

  isCustomPage(): boolean {
    return this.navStyle.get('navigationStyle') === "custom";
  }

  /**
   * 微信规则（真机实测语义）：默认导航栏 + 非应用首页（entryPagePath，缺省取 pages[0]）+
   * 非 tabBar 页（这两条排除 homeButton: true 也不能突破），且满足其一：页面栈栈底（自动规则），
   * 或页面配置 homeButton: true（此时与返回箭头并存显示）。
   * wx.hideHomeButton() 通过 navStyle 的 hideHomeButton 标记强制隐藏，优先级最高（见 DMPContainerBridgesModuleNavigationBar）。
   */
  shouldShowHomeButton(webViewId: number): boolean {
    if (this.isCustomPage()) {
      return false;
    }
    if (this.navStyle.get('hideHomeButton') === true) {
      return false;
    }
    const app = DMPAppManager.sharedInstance().getApp(this.appIndex);
    if (!app) {
      return false;
    }
    const pagePath = app.navigatorManager.getPageRecordById(webViewId)?.pagePath;
    const appConfig = app.bundleManager.getJsAppModuleConfig();
    if (!pagePath || !appConfig || !appConfig.entryPagePath) {
      return false;
    }
    if (appConfig.isTabBarPage(pagePath) || pagePath === appConfig.entryPagePath) {
      return false;
    }
    const isStackBottom = app.navigatorManager.getPageCountForWebViewId(webViewId) <= 1;
    return isStackBottom || this.navStyle.get('homeButton') === true;
  }

  getTitleString(): string {
    DMPLogger.d("isStatusBarDarkMode getTitleString=", this.navStyle.get('navigationBarTitleText'));
    if (this.navStyle.get('navigationBarTitleText')) {
      return this.navStyle.get('navigationBarTitleText');
    }
    if (this.navStyle.get('window') && this.navStyle.get('window').get('navigationBarTitleText')) {
      return this.navStyle.get('window').get('navigationBarTitleText');
    }
    return "";
  }

  getTitleTextColor(): string {
    if (this.navStyle.get('navigationBarTextColor')) {
      return this.navStyle.get('navigationBarTextColor');
    }
    if (this.isStatusBarDarkMode()) {
      return '#000000';
    }
    return '#ffffff';
  }

  getNavigationBarBackGroundColor(): string {
    if (this.navStyle.get('navigationBarBackgroundColor')) {
      return this.navStyle.get('navigationBarBackgroundColor');
    }
    if (this.navStyle.get('window') && this.navStyle.get('window').get('navigationBarBackgroundColor')) {
      return this.navStyle.get('window').get('navigationBarBackgroundColor');
    }
    return '#ffffff';
  }
}