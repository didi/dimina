import { DMPMap } from '../Utils/DMPMap'
import { DMPContainerBridgesModule } from './DMPContainerBridgesModule'

import { DMPBridgeCallback } from './DMPTSUtil'
import { bundleManager, common } from '@kit.AbilityKit'
import { BusinessError } from '@ohos.base'
import fs from '@ohos.file.fs'
import fileIo from '@ohos.file.fs'
import image from '@ohos.multimedia.image'

import camera from '@ohos.multimedia.camera'
import { DMPFileUrlConvertor } from '../Bundle/Util/DMPFileUrlConvertor'
import { DMPContextUtils } from '../Utils/DMPContextUtils'
import { DMPLogger } from '../EventTrack/DMPLogger'
import { photoAccessHelper } from '@kit.MediaLibraryKit'
import { PhotoPicker } from './PhotoView/PhotoPicker'
import { CameraPicker } from './PhotoView/CameraPicker'
import { DRouter } from '../Navigator/DRouter'
import { DMPPhotoPreview } from './PhotoView/DMPPhotoPreview'
import { DMPOpenType } from '../DApp/config/DMPLaunchConfig'

export class DMPContainerBridgesModuleImage extends DMPContainerBridgesModule {
  getExportMethods(): string[] {
    return ['getImageInfo', 'chooseImage', 'saveImageToPhotosAlbum', 'previewImage',
      'compressImage'];
  }

  getImageInfo(data: DMPMap, callback: DMPBridgeCallback) {
    const localPath: string = data.get('src')
    const imageSourceApi = image.createImageSource(localPath);
    imageSourceApi.getImageInfo(0, (error, imageInfo) => {
      if (error) {
        this.invokeFailureCallback(callback, null, '保存失败')
      } else {
        const data = new DMPMap()
        data.set('width', imageInfo.size.width);
        data.set('height', imageInfo.size.height);
        data.set('path', localPath);
        this.invokeSuccessCallback(callback, data)
      }
    })
  }

  /*
   * sourceType:album 相册  camera 相机
   * sizeType：original 原图 compressed 压缩
   * count：9 1次选择的图片个数，默认1，范围：【1-9】
   * */
  chooseImage(data: DMPMap, callback: DMPBridgeCallback) {
    const sourceType: string[] = data.getArray<string>('sourceType') ?? ['album', 'camera'];
    const count: number = data.getNumber('count') ?? 9;
    const source = sourceType[0] ?? 'album';
    if ('album' == source) {
      let path = DMPContextUtils.getUIAbilityContext().cacheDir + '/chooseImage';
      PhotoPicker.selectPhotos(DMPContextUtils.getUIAbilityContext(), path, count).then((photoModels) => {
        if (photoModels != null) {
          const tempfilePaths = new Array<string>()
          const tempFiles = new Array<Map<string, object>>()
          photoModels.forEach((element) => {
            const vPath = DMPFileUrlConvertor.vPathFromLocalPath(element.localPath)
            const tempFileDic = new Map<string, object>()
            tempFileDic['path'] = vPath
            tempfilePaths.push(vPath)
            tempFiles.push(tempFileDic)
          })
          const data = new DMPMap()
          data.set('tempFilePaths', tempfilePaths);
          data.set('tempFiles', tempFiles);
          this.invokeSuccessCallback(callback, data)
        } else {
          this.invokeFailureCallback(callback, null, '选择照片失败')
        }
      });
    } else if ('camera' == source) {
      try {
        // 这里是处理文件名 , 应该是系统有bug , 无法使用 saveuri , 需要选择后保存
        let path =DMPContextUtils.getUIAbilityContext().cacheDir + '/chooseImage';

        CameraPicker.takePhoto(getContext() as common.UIAbilityContext, path,
          camera.CameraPosition.CAMERA_POSITION_BACK).then((result) => {

          if (result) {
            this.returnImageChoose(result.localPath, callback)
          } else {
            this.invokeFailureCallback(callback, null, '拍照失败')
          }
        })

      } catch (error) {
        let err = error as BusinessError;
        this.invokeFailureCallback(callback, null, `拍照失败${err.code}`)
      }
    }
  }

  returnImageChoose(path: string, callback: DMPBridgeCallback) {
    const vPath = DMPFileUrlConvertor.vPathFromLocalPath(path)

    const tempfilePaths = new Array<string>()
    tempfilePaths.push(vPath)

    const tempFiles = new Array<Map<string, object>>()
    const tempFileDic = new Map<string, object>()


    tempFileDic['path'] = vPath
    tempFiles.push(tempFileDic)

    const data = new DMPMap()
    data.set('tempFilePaths', tempfilePaths);
    data.set('tempFiles', tempFiles);

    this.invokeSuccessCallback(callback, data)
  }


  saveImageToPhotosAlbum(data: DMPMap, callback: DMPBridgeCallback) {
    this.saveImage(data, callback)
  }

  async saveImage(data: DMPMap, callback: DMPBridgeCallback) {
    let filePath: string = data.get('filePath')
    try {
      const bundleInfo =
        bundleManager.getBundleInfoForSelfSync(bundleManager.BundleFlag.GET_BUNDLE_INFO_WITH_APPLICATION)

      filePath = this.getRealSandBoxPath(filePath, bundleInfo.name)
      let srcFileUris: Array<string> = [filePath];
      // 指定待保存照片的创建选项，包括文件后缀和照片类型，标题和照片子类型可选
      let photoCreationConfigs: Array<photoAccessHelper.PhotoCreationConfig> = [
        {
          fileNameExtension: 'jpg',
          photoType: photoAccessHelper.PhotoType.IMAGE,
          subtype: photoAccessHelper.PhotoSubtype.DEFAULT, // 可选
        }
      ];
      let phAccessHelper = photoAccessHelper.getPhotoAccessHelper(DMPContextUtils.getUIAbilityContext());
      // 基于弹窗授权的方式获取媒体库的目标uri
      let desFileUris: Array<string> = await phAccessHelper.showAssetsCreationDialog(srcFileUris, photoCreationConfigs);
      // 将来源于应用沙箱的照片内容写入媒体库的目标uri
      let desFile: fileIo.File = await fileIo.open(desFileUris[0], fileIo.OpenMode.WRITE_ONLY);
      let srcFile: fileIo.File = await fileIo.open(filePath, fileIo.OpenMode.READ_ONLY);
      await fileIo.copyFile(srcFile.fd, desFile.fd);
      fileIo.closeSync(srcFile);
      fileIo.closeSync(desFile);

      this.invokeSuccessCallback(callback, null)
    } catch (err) {
      this.invokeFailureCallback(callback, null, '保存相册失败')
      DMPLogger.e(`victor failed to create asset by dialog successfully errCode is: ${err.code}, ${err.message}`);
    }
  }

  getRealSandBoxPath(filePath: string, bundleName: string): string {
    // 定义需要检查的前缀
    const prefixes = ['difile://', 'file:///', 'file://', '/'];

    for (const prefix of prefixes) {
      if (filePath.startsWith(prefix)) {
        filePath = filePath.slice(prefix.length);
        break;
      }
    }

    return `file://${bundleName}/${filePath}`;
  }

  previewImage(data: DMPMap, callback: DMPBridgeCallback) {
    const urls: [string] = data.get('urls');
    const currentUrl: string = data.get('current');
    const showmenu: boolean = data.get('showmenu') ?? true;
    let index = urls.indexOf(currentUrl)
    if (index === -1) {
      index = 0
    }
    DRouter.getInstance()
      .build(DMPPhotoPreview.ROUTE_NAME)
      .putExtra("urls", urls)
      .putExtra("index", index)
      .setNavMode(DMPOpenType.NavigateTo)
      .start()
    this.invokeSuccessCallback(callback, null)
  }

  compressImage(data: DMPMap, callback: DMPBridgeCallback) {
    const dataQuality: number = data.get('quality');
    const url = DMPFileUrlConvertor.localPathFromVPath(data.get('src'));
    let quality = 80
    if (dataQuality > 0 && dataQuality < 100) {
      quality = dataQuality
    }

    const context = DMPContextUtils.getUIAbilityContext();
    const timestamp = new Date().getTime().toString();
    const localPath: string = `${context.tempDir}/${timestamp}.jpg`;
    const imageSourceApi = image.createImageSource(url);
    let packOpts: image.PackingOption = { format: "image/jpeg", quality: quality };
    const imagePackerApi = image.createImagePacker();
    imagePackerApi.packing(imageSourceApi, packOpts).then(resultData => {
      let file = fs.openSync(localPath, fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE);
      fs.writeSync(file.fd, resultData)
      fs.closeSync(file);
      const result = new DMPMap();
      result.set('tempFilePath', DMPFileUrlConvertor.vPathFromLocalPath(localPath));
      this.invokeSuccessCallback(callback, result)
    }).catch((error: BusinessError) => {
      this.invokeFailureCallback(callback, null, '压缩失败')
    })
  }
}
