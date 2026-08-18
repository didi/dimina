
import { abilityAccessCtrl, bundleManager, common, PermissionRequestResult, Permissions } from '@kit.AbilityKit';
import { DMPLogger } from '../../EventTrack/DMPLogger';

const TAG: string = '[Permission]';

const PERMISSIONS: Array<Permissions> = [
  'ohos.permission.CAMERA'
];

const context = getContext(this) as common.UIAbilityContext;

export async function getPermissionStatus(permissionKey:Permissions):Promise<boolean> {
  try {
    let bundleInfo: bundleManager.BundleInfo =
      await bundleManager.getBundleInfoForSelf(
        bundleManager.BundleFlag.GET_BUNDLE_INFO_WITH_APPLICATION
      );
    let appInfo: bundleManager.ApplicationInfo = bundleInfo.appInfo;
    let tokenId = appInfo.accessTokenId;
    let atManager = abilityAccessCtrl.createAtManager();
    let state = await atManager.checkAccessToken(tokenId, permissionKey);
    DMPLogger.i(TAG, 'grantPermission success');
    return state === abilityAccessCtrl.GrantStatus.PERMISSION_GRANTED // 允许
  }catch (error) {
    DMPLogger.e(TAG, 'grantPermission fail');
    return false;
  }
}


export default async function grantPermission(): Promise<boolean> {
  try {
    let bundleInfo: bundleManager.BundleInfo =
      await bundleManager.getBundleInfoForSelf(
        bundleManager.BundleFlag.GET_BUNDLE_INFO_WITH_APPLICATION
      );
    let appInfo: bundleManager.ApplicationInfo = bundleInfo.appInfo;
    let tokenId = appInfo.accessTokenId;
    let atManager = abilityAccessCtrl.createAtManager();
    let pems: Array<Permissions> = [];
    for (let i = 0; i < PERMISSIONS.length; i++) {
      let state = await atManager.checkAccessToken(tokenId, PERMISSIONS[i]);
      DMPLogger.i(TAG, `grantPermission checkAccessToken ${PERMISSIONS[i]} +: ${JSON.stringify(state)}`);
      if (state !== abilityAccessCtrl.GrantStatus.PERMISSION_GRANTED) {
        pems.push(PERMISSIONS[i]);
      }
    }
    if (pems.length > 0) {
      DMPLogger.i(TAG, 'grantPermission requestPermissionsFromUser:' + JSON.stringify(pems));
      let ctx = context
      let result: PermissionRequestResult = await atManager.requestPermissionsFromUser(ctx, pems);
      let grantStatus: Array<number> = result.authResults;
      let length: number = grantStatus.length;
      for (let i = 0; i < length; i++) {
        DMPLogger.i(TAG, `grantPermission requestPermissionsFromUser ${result.permissions[i]} +: ${grantStatus[i]}`);
        if (grantStatus[i] !== 0) {
          DMPLogger.w(TAG, 'grantPermission fail');
          return false;
        }
      }
    }
    DMPLogger.i(TAG, 'grantPermission success');
    return true;
  } catch (error) {
    DMPLogger.e(TAG, 'grantPermission fail');
    return false;
  }
}
