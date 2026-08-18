import { DMPMap } from "../Utils/DMPMap";
import { DRouter } from "./DRouter";
import { DMPLogger } from "../EventTrack/DMPLogger";

export class Request {
  private routeName: string;
  private extras: DMPMap;
  private navMode?: number;
  private animated: boolean = false;

  constructor(routeName: string) {
    this.routeName = routeName;
    this.extras = new DMPMap();
  }

  setAnimated(animated: boolean) {
    this.animated = animated;
  }

  putExtra(key: string, value: Object): Request {
    this.extras.set(key, value);
    return this;
  }

  setNavMode(navMode: number): Request {
    this.navMode = navMode;
    return this;
  }

  start(): void {
    DMPLogger.d('', `Navigate to ${this.routeName} with extras: ${this.extras.toStr()}`);
    switch (this.navMode) {
      case 0:
        DRouter.getInstance().push(this.routeName, this.extras)
        break;
      case 1:
        DRouter.getInstance().replace(this.routeName, this.extras)
        break;
    }
  }

}
