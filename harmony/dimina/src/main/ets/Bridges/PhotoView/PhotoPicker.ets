import { BusinessError } from '@ohos.base';
import photoAccessHelper from '@ohos.file.photoAccessHelper';
import common from '@ohos.app.ability.common';
import { AssetModel } from './AssetModel';
import { PickHelper } from './PickHelper';
import { DMPLogger } from '../../EventTrack/DMPLogger';

export class PhotoPicker {
  /**
   * 调用系统相册选择图片（无权限）
   *
   * @param context 上下文(预留)
   * @param toDir 存放位置，会把照片copy过去
   * @param maxSelectNumber 最多能选择多少张
   * @param isEditSupported 是否支持编辑，默认ture
   * @returns 返回AssetModel
   */
  public static async selectPhotos(context: common.UIAbilityContext, localDir: string,
    maxSelectNumber: number = 9, isEditSupported: boolean = true): Promise<Array<AssetModel> | null> {
    let PhotoSelectOptions = new photoAccessHelper.PhotoSelectOptions();
    PhotoSelectOptions.MIMEType = photoAccessHelper.PhotoViewMIMETypes.IMAGE_TYPE;
    PhotoSelectOptions.maxSelectNumber = maxSelectNumber;
    PhotoSelectOptions.isEditSupported = isEditSupported;
    let photoPicker = new photoAccessHelper.PhotoViewPicker();
    return photoPicker.select(PhotoSelectOptions)
      .then(async (PhotoSelectResult: photoAccessHelper.PhotoSelectResult) => {
        let uris = PhotoSelectResult.photoUris;
        let models = await PickHelper.makeAssetModels(uris, localDir)
        return models;
      })
      .catch((err: BusinessError) => {
        DMPLogger.e('', `PhotoViewPicker.select failed with err: ${err.code}, ${err.message}`);
        return null
      });
  }

  /**
   * 调用系统相册选择录像（无权限）
   *
   * @param context 上下文(预留)
   * @param toDir 存放位置，会把照片copy过去
   * @param maxSelectNumber 最多能选择多少张
   * @param isEditSupported 是否支持编辑，默认ture
   * @returns 返回AssetModel
   */
  public static async selectVideos(context: common.UIAbilityContext, localDir: string,
    maxSelectNumber: number = 9, isEditSupported: boolean = true): Promise<Array<AssetModel> | null> {
    let PhotoSelectOptions = new photoAccessHelper.PhotoSelectOptions();
    PhotoSelectOptions.MIMEType = photoAccessHelper.PhotoViewMIMETypes.VIDEO_TYPE;
    PhotoSelectOptions.maxSelectNumber = maxSelectNumber;
    PhotoSelectOptions.isEditSupported = isEditSupported;
    let photoPicker = new photoAccessHelper.PhotoViewPicker();
    return photoPicker.select(PhotoSelectOptions)
      .then(async (PhotoSelectResult: photoAccessHelper.PhotoSelectResult) => {
        let uris = PhotoSelectResult.photoUris;
        let models = await PickHelper.makeAssetModels(uris, localDir)
        return models;
      })
      .catch((err: BusinessError) => {
        DMPLogger.e('', `PhotoViewPicker.select failed with err: ${err.code}, ${err.message}`);
        return null
      });
  }
}
