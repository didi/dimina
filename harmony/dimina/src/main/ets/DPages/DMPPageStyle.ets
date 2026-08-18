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

  isHomeButtonHidden(): boolean {
    return this.navStyle.get('hideHomeButton') === true
  }

  getHomeButtonConfig(): boolean {
    return this.navStyle.get('homeButton') === true
  }

  isNavigationBarLoading(): boolean {
    return this.navStyle.get('navigationBarLoading') === true
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