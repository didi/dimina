import { DMPMap } from '../Utils/DMPMap';
import { DMPContainerBridgesModule } from './DMPContainerBridgesModule';
import { DMPBridgeCallback } from './DMPTSUtil';
import { abilityAccessCtrl, common, Permissions } from '@kit.AbilityKit';
import { getPermissionStatus } from '../Render/SameLayer/PermissionUtils';
import { DMPContextUtils } from '../Utils/DMPContextUtils';
import { BusinessError } from '@kit.BasicServicesKit';
import { DMPLogger } from '../EventTrack/DMPLogger';


const userLocationScope = 'scope.userLocation' // 定位权限
const writePhotosAlbumScope = 'scope.writePhotosAlbum' //相册权限
const cameraScope = 'scope.camera' // 相机权限
const recordScope = 'scope.record' // 录音权限
const contactScope = 'scope.contact' // 通讯录权限

const supportPermissionMap = new Map<string, Permissions>([
  [userLocationScope, "ohos.permission.LOCATION"],
  [writePhotosAlbumScope, "ohos.permission.WRITE_IMAGEVIDEO"],
  [cameraScope, "ohos.permission.CAMERA"],
  [recordScope, "ohos.permission.MICROPHONE"],
  [contactScope, "ohos.permission.READ_CONTACTS"],
]);

export class DMPContainerBridgesModuleOpenSetting extends DMPContainerBridgesModule {
  getExportMethods(): string[] {
    return ['getSetting', 'openSetting', 'authorize'];
  }


  getSetting(data: DMPMap, callback: DMPBridgeCallback) {

    const scope = new Map<string, number>();

    getPermissionStatus('ohos.permission.CAMERA')// 相机权限
      .then((cameraStatus) => {
        scope[cameraScope] = cameraStatus;
        return getPermissionStatus('ohos.permission.READ_MEDIA'); // 相册权限
      })
      .then((albumStatus) => {
        scope[writePhotosAlbumScope] = albumStatus;
        return getPermissionStatus('ohos.permission.LOCATION'); // 定位权限
      })
      .then((locationStatus) => {
        scope[userLocationScope] = locationStatus;
        return getPermissionStatus('ohos.permission.READ_CONTACTS'); // 通讯录权限
      })
      .then((contactStatus) => {
        scope[contactScope] = contactStatus;
        return getPermissionStatus('ohos.permission.MICROPHONE'); // 麦克风权限
      })
      .then((recordStatus) => {
        scope[recordScope] = recordStatus;
        const result = new DMPMap();
        result.set('authSetting', scope);
        this.invokeSuccessCallback(callback, result);
      })
      .catch((err: BusinessError) => {
        this.invokeFailureCallback(callback, null, '获取失败')
      })
  }

  openSetting(data: DMPMap, callback: DMPBridgeCallback) {
    let context = DMPContextUtils.getUIAbilityContext()
    context.startAbility({
      bundleName: 'com.huawei.hmos.settings',
      abilityName: 'com.huawei.hmos.settings.MainAbility',
      // 根据”设置”应用配置的界面信息，选择不同的uri
      // uri: 'wifi_entry'
    })
    this.invokeSuccessCallback(callback, null)
  }

  authorize(data: DMPMap, callback: DMPBridgeCallback) {
    let context = DMPContextUtils.getUIAbilityContext()
    const scope = data.getString('scope') ?? '';
    if (scope == 'scope.writePhotosAlbum') {
      //弹出保存方式不需要权限申请
      this.invokeSuccessCallback(callback, null)
      return
    }
    if (supportPermissionMap.has(scope)) {
      this.reqPermissionsFromUser(supportPermissionMap.get(scope)!, context, (status) => {
        if (status) {
          this.invokeSuccessCallback(callback, null)
        } else {
          this.invokeFailureCallback(callback, null, '申请权限失败')
        }
      })
    } else {
      this.invokeFailureCallback(callback, null, '申请权限失败')
    }

  }

  reqPermissionsFromUser(permission: Permissions, context: common.UIAbilityContext,
    onCallBack: (granted: boolean) => void): void {
    let atManager: abilityAccessCtrl.AtManager = abilityAccessCtrl.createAtManager();
    // requestPermissionsFromUser会判断权限的授权状态来决定是否唤起弹窗
    atManager.requestPermissionsFromUser(context, [permission]).then((data) => {
      let grantStatus: Array<number> = data.authResults;
      let length: number = grantStatus.length;
      for (let i = 0; i < length; i++) {
        if (grantStatus[i] === 0) {
          // 用户授权，可以继续访问目标操作
          onCallBack(true)
        } else {
          // 用户拒绝授权，提示用户必须授权才能访问当前页面的功能，并引导用户到系统设置中打开相应的权限
          onCallBack(false)
          return;
        }
      }
      // 授权成功
    }).catch((err: BusinessError) => {
      onCallBack(false)
      DMPLogger.e('', `Failed to request permissions from user. Code is ${err.code}, message is ${err.message}`);
    })
  }
}
