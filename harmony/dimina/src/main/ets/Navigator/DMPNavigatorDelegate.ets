import { DMPApp } from '../DApp/DMPApp';
import { DMPMap } from '../Utils/DMPMap';
import { DMPNavigator } from './DMPNavigator';
import { DMPIdProvider } from './DMPIdProvider';
import { DMPLaunchConfig } from '../DApp/config/DMPLaunchConfig';

export class DMPNavigatorDelegate {
  private _id: number;
  private _navigator: DMPNavigator;
  private _launchConfig: DMPLaunchConfig;

  public get id(): number {
    return this._id;
  }

  constructor(app: DMPApp, launchConfig: DMPLaunchConfig) {
    this._navigator = new DMPNavigator(app);
    this._id = DMPIdProvider.generateStackId();
    this._launchConfig = launchConfig
  }

  public isContainsWebViewId(webViewId:number):boolean{
    return this._navigator.isContainsWebViewId(webViewId)
  }

  async launch() {
    await this._navigator.launch(this._id, this._launchConfig)
  }

  async relaunchTo(params: DMPMap) {
    await this._navigator.relaunchTo(params);
  }

  async navigateTo(params: DMPMap) {
    await this._navigator.navigateTo(this._id, params);
  }

  async redirectTo(params: DMPMap) {
    await this._navigator.redirectTo(this._id, params);
  }

  async pop(delta: number = 1) {
    await this._navigator.pop(delta);
  }

  async navigateBack(delta: number, animated = true, canDestroy = true,isReLaunch = false) {
    await this._navigator.navigateBack(delta, animated, canDestroy,isReLaunch);
  }

  async switchTab(params: DMPMap) {
    await this._navigator.switchTab(params);
  }

  getPageCount(): number {
    return this._navigator.pageCount()
  }

  getLaunchConfig(): DMPLaunchConfig {
    return this._launchConfig
  }

  getNavigator(): DMPNavigator {
    return this._navigator;
  }
}
