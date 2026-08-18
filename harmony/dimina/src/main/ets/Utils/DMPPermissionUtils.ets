import { abilityAccessCtrl, bundleManager, common, Permissions } from "@kit.AbilityKit";
import { BusinessError } from "@kit.BasicServicesKit";
import { DMPLogger } from '../EventTrack/DMPLogger';

export class DMPPermissionUtils {
  // 检查粘贴板权限
  static async checkPasteBoardPermissions(context: common.UIAbilityContext, onResult: (granted: boolean) => void): Promise<void> {
    let permissions: Array<Permissions> = ['ohos.permission.READ_PASTEBOARD'];
    let grantStatus: abilityAccessCtrl.GrantStatus = await DMPPermissionUtils.checkPermissionGrant(permissions[0]);

    if (grantStatus === abilityAccessCtrl.GrantStatus.PERMISSION_GRANTED) {
      onResult(true)
    } else {
      DMPPermissionUtils.reqPermissionsFromUser(permissions, context, onResult)
    }
    return;
  }

  static async checkPermissionGrant(permission: Permissions): Promise<abilityAccessCtrl.GrantStatus> {
    let atManager: abilityAccessCtrl.AtManager = abilityAccessCtrl.createAtManager();
    let grantStatus: abilityAccessCtrl.GrantStatus = abilityAccessCtrl.GrantStatus.PERMISSION_DENIED;

    // 获取应用程序的accessTokenID
    let tokenId: number = 0;
    try {
      let bundleInfo: bundleManager.BundleInfo =
        await bundleManager.getBundleInfoForSelf(bundleManager.BundleFlag.GET_BUNDLE_INFO_WITH_APPLICATION);
      let appInfo: bundleManager.ApplicationInfo = bundleInfo.appInfo;
      tokenId = appInfo.accessTokenId;
    } catch (error) {
      const err: BusinessError = error as BusinessError;
      DMPLogger.e('', `Failed to get bundle info for self. Code is ${err.code}, message is ${err.message}`);
    }

    // 校验应用是否被授予权限
    try {
      grantStatus = await atManager.checkAccessToken(tokenId, permission);
    } catch (error) {
      const err: BusinessError = error as BusinessError;
      DMPLogger.e('', `Failed to check access token. Code is ${err.code}, message is ${err.message}`);
    }

    return grantStatus;
  }

  static reqPermissionsFromUser(permissions: Array<Permissions>, context: common.UIAbilityContext,
    onResult: (granted: boolean) => void): void {
    let atManager: abilityAccessCtrl.AtManager = abilityAccessCtrl.createAtManager();
    atManager.requestPermissionsFromUser(context, permissions).then((data) => {
      let grantStatus: Array<number> = data.authResults;
      let length: number = grantStatus.length;
      let grantResults = grantStatus.filter((value, _, __) => value == 0);
      if (grantResults && grantResults.length == permissions.length) {
        onResult(true)
      } else {
        onResult(false)
      }
      // 授权成功
    }).catch((err: BusinessError) => {
      DMPLogger.e('', `checkPermissions Failed to request permissions from user. Code is ${err.code}, message is ${err.message}`);
    })
  }
}
