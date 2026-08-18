import { DMPContainerBridgesModule } from './DMPContainerBridgesModule'

import { DMPBridgeCallback } from './DMPTSUtil'
import { DMPDeviceUtil } from '../Utils/DMPDeviceUtils'
import { DMPMap } from '../Utils/DMPMap'
import { DMPMenuButtonLayout } from '../Utils/DMPMenuButtonLayout'


export class DMPContainerBridgesModuleMenu extends DMPContainerBridgesModule {
  getExportMethods(): string[] {
    return ['getMenuButtonBoundingClientRect'];
  }

  // 界面 / 菜单 / wx.getMenuButtonBoundingClientRect
  // https://developers.weixin.qq.com/miniprogram/dev/api/ui/menu/wx.getMenuButtonBoundingClientRect.html
  getMenuButtonBoundingClientRect(data: DMPMap, callback: DMPBridgeCallback) {
    return DMPMenuButtonLayout.buildFromWindowMetrics(DMPDeviceUtil.getSafeAreaAndDisplayWHSync())
  }
}
