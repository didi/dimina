import { DMPContainerBridgesModule } from './DMPContainerBridgesModule'

import { DMPBridgeCallback } from './DMPTSUtil'
import { DMPDeviceUtil } from '../Utils/DMPDeviceUtils'
import { DMPMap } from '../Utils/DMPMap'


export class DMPContainerBridgesModuleMenu extends DMPContainerBridgesModule {
  getExportMethods(): string[] {
    return ['getMenuButtonBoundingClientRect'];
  }

  // 界面 / 菜单 / wx.getMenuButtonBoundingClientRect
  // https://developers.weixin.qq.com/miniprogram/dev/api/ui/menu/wx.getMenuButtonBoundingClientRect.html
  getMenuButtonBoundingClientRect(data: DMPMap, callback: DMPBridgeCallback) {
    const whData = DMPDeviceUtil.getSafeAreaAndDisplayWHSync()

    const width = 87;
    const height = 32;
    const navigationBarContentHeight = 55;
    const top = (whData.get('statusBarHeight') as number) + Math.round((navigationBarContentHeight - height) / 2);
    const right = whData.get('windowWidth') - 10;
    const left = right - width;
    const bottom = top + height;

    const menuButtonBoundingClientRect = new DMPMap({
      top: top,
      left: left,
      width: width,
      height: height,
      bottom: bottom,
      right: right,
      x: left,
      y: top,
    })
    return menuButtonBoundingClientRect
  }
}

