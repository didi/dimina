import { DMPMap } from '../Utils/DMPMap'
import { DMPContainerBridgesModule } from './DMPContainerBridgesModule'

import { DMPBridgeCallback } from './DMPTSUtil'
import { common } from '@kit.AbilityKit'
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
import picker from '@ohos.file.picker'
import { fileUri } from '@kit.CoreFileKit'
import { request } from '@kit.BasicServicesKit'
import { DMPFilePathResolver } from '../Bundle/Util/DMPFilePathResolver'

export class DMPContainerBridgesModuleImage extends DMPContainerBridgesModule {
  getExportMethods(): string[] {
    return ['getImageInfo', 'chooseImage', 'chooseMessageFile', 'saveImageToPhotosAlbum', 'previewImage',
      'previewMedia', 'compressImage'];
  }

  async getImageInfo(data: DMPMap, callback: DMPBridgeCallback) {
    const src = data.getString('src') ?? '';
    try {
      const localPath = await this.resolveImagePath(src);
      const imageSourceApi = image.createImageSource(localPath);
      try {
        const info = await imageSourceApi.getImageInfo(0);
        let orientation = 'up';
        try {
          orientation = this.imageOrientation(await imageSourceApi.getImageProperty(image.PropertyKey.ORIENTATION));
        } catch (_) {
          orientation = 'up';
        }
        const result = new DMPMap();
        result.set('width', info.size.width);
        result.set('height', info.size.height);
        result.set('path', DMPFileUrlConvertor.vPathFromLocalPath(localPath));
        result.set('orientation', orientation);
        result.set('type', info.mimeType?.split('/').pop()?.toLowerCase() ?? 'unknown');
        result.set('errMsg', 'getImageInfo:ok');
        this.invokeSuccessCallback(callback, result, true);
      } finally {
        imageSourceApi.release();
      }
    } catch (error) {
      this.invokeFailureCallback(callback, null, `getImageInfo:fail ${error}`);
    }
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
      const path = this.mediaTempDirectory('chooseImage');
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
        const path = this.mediaTempDirectory('chooseImage');

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

  async chooseMessageFile(data: DMPMap, callback: DMPBridgeCallback) {
    const countValue: number | undefined = data.getNumber('count');
    if (countValue === undefined || countValue < 0 || countValue > 100 || !Number.isInteger(countValue)) {
      this.failChooseMessageFile(callback, 'invalid count');
      return;
    }
    const count: number = countValue;

    const requestedType: string = data.getString('type') ?? 'all';
    if (!['all', 'image', 'video', 'file'].includes(requestedType)) {
      this.failChooseMessageFile(callback, 'invalid type');
      return;
    }

    const extensionValue: Array<Object> | undefined = data.getArray<Object>('extension');
    if (requestedType === 'file' && data.hasOwnKey('extension') && !Array.isArray(extensionValue)) {
      this.failChooseMessageFile(callback, 'invalid extension');
      return;
    }
    const extensions = new Array<string>();
    if (requestedType === 'file' && extensionValue !== undefined) {
      for (let index = 0; index < extensionValue.length; index++) {
        const value: Object = extensionValue[index];
        if (typeof value !== 'string') {
          this.failChooseMessageFile(callback, 'invalid extension');
          return;
        }
        const normalized: string = value.trim().replace(/^\./, '').toLowerCase();
        if (normalized.length === 0) {
          this.failChooseMessageFile(callback, 'invalid extension');
          return;
        }
        extensions.push(normalized);
      }
    }

    if (count === 0) {
      this.successChooseMessageFile(callback, new Array<DMPMap>());
      return;
    }

    const options = new picker.DocumentSelectOptions();
    options.maxSelectNumber = count;
    if (requestedType === 'image') {
      options.fileSuffixFilters = DMPContainerBridgesModuleImage.imageExtensions.map((value: string) => `.${value}`);
    } else if (requestedType === 'video') {
      options.fileSuffixFilters = DMPContainerBridgesModuleImage.videoExtensions.map((value: string) => `.${value}`);
    } else if (requestedType === 'file' && extensions.length > 0) {
      options.fileSuffixFilters = extensions.map((value: string) => `.${value}`);
    }

    try {
      const documentPicker = new picker.DocumentViewPicker(DMPContextUtils.getUIAbilityContext());
      const uris = await documentPicker.select(options);
      if (uris.length === 0) {
        this.failChooseMessageFile(callback, 'cancel');
        return;
      }

      const directory = this.mediaTempDirectory('chooseMessageFile');

      const tempFiles = new Array<DMPMap>();
      const copiedPaths = new Array<string>();
      try {
        for (let index = 0; index < Math.min(uris.length, count); index++) {
          const uri = uris[index];
          const name = this.messageFileName(uri, index);
          const actualType = this.messageFileType(name);
          const extension = this.messageFileExtension(name);
          const accepted = requestedType === 'all'
            || (requestedType === actualType
              && (requestedType !== 'file' || extensions.length === 0 || extensions.includes(extension)));
          if (!accepted) {
            continue;
          }

          const suffix = extension.substring(0, 20);
          const localPath = `${directory}/${Date.now()}_${index}${suffix.length > 0 ? `.${suffix}` : ''}`;
          await fs.copy(uri, fileUri.getUriFromPath(localPath));
          copiedPaths.push(localPath);
          const stat = fs.statSync(localPath);
          const item = new DMPMap();
          item.set('name', name);
          item.set('path', DMPFileUrlConvertor.vPathFromLocalPath(localPath));
          item.set('size', stat.size);
          item.set('time', Math.floor((stat.mtime > 0 ? stat.mtime : Date.now()) / 1000));
          item.set('type', actualType);
          tempFiles.push(item);
        }

        if (tempFiles.length === 0) {
          throw new Error('no supported file selected');
        }
        this.successChooseMessageFile(callback, tempFiles);
      } catch (error) {
        copiedPaths.forEach((path: string) => {
          if (fs.accessSync(path)) {
            fs.unlinkSync(path);
          }
        });
        const reason: string = error instanceof Error ? error.message : 'cannot read selected file';
        this.failChooseMessageFile(callback, reason);
        return;
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'cannot read selected file';
      this.failChooseMessageFile(callback, reason);
    }
  }

  private static readonly imageExtensions: string[] = [
    'apng', 'avif', 'bmp', 'gif', 'heic', 'heif', 'ico', 'jpeg', 'jpg', 'png', 'svg', 'tif', 'tiff', 'webp'
  ];
  private static readonly videoExtensions: string[] = [
    '3g2', '3gp', 'avi', 'flv', 'm2ts', 'm4v', 'mkv', 'mov', 'mp4', 'mpeg', 'mpg', 'mts', 'ogv', 'ts', 'webm', 'wmv'
  ];

  private messageFileName(uri: string, index: number): string {
    const rawName = uri.split('?')[0].split('/').pop() ?? `file_${index}`;
    try {
      return decodeURIComponent(rawName) || `file_${index}`;
    } catch (_) {
      return rawName || `file_${index}`;
    }
  }

  private messageFileExtension(name: string): string {
    const dotIndex = name.lastIndexOf('.');
    return dotIndex >= 0 ? name.substring(dotIndex + 1).toLowerCase() : '';
  }

  private messageFileType(name: string): string {
    const extension = this.messageFileExtension(name);
    if (DMPContainerBridgesModuleImage.imageExtensions.includes(extension)) {
      return 'image';
    }
    if (DMPContainerBridgesModuleImage.videoExtensions.includes(extension)) {
      return 'video';
    }
    return 'file';
  }

  private successChooseMessageFile(callback: DMPBridgeCallback, tempFiles: Array<DMPMap>) {
    const result = new DMPMap();
    result.set('tempFiles', tempFiles);
    result.set('errMsg', 'chooseMessageFile:ok');
    this.invokeSuccessCallback(callback, result, true);
  }

  private failChooseMessageFile(callback: DMPBridgeCallback, reason: string) {
    const result = new DMPMap();
    const errMsg = `chooseMessageFile:fail ${reason}`;
    result.set('errMsg', errMsg);
    this.invokeFailureCallback(callback, result, errMsg, true);
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
    try {
      const filePath = this.resolvePackagedMediaPath(data.getString('filePath') ?? '');
      if (!fs.accessSync(filePath)) {
        throw new Error('invalid filePath');
      }
      const srcFileUris: Array<string> = [fileUri.getUriFromPath(filePath)];
      // 指定待保存照片的创建选项，包括文件后缀和照片类型，标题和照片子类型可选
      const photoCreationConfigs: Array<photoAccessHelper.PhotoCreationConfig> = [
        {
          fileNameExtension: this.pathExtension(filePath, 'jpg'),
          photoType: photoAccessHelper.PhotoType.IMAGE,
          subtype: photoAccessHelper.PhotoSubtype.DEFAULT, // 可选
        }
      ];
      const phAccessHelper = photoAccessHelper.getPhotoAccessHelper(DMPContextUtils.getUIAbilityContext());
      // 基于弹窗授权的方式获取媒体库的目标uri
      const desFileUris: Array<string> = await phAccessHelper.showAssetsCreationDialog(srcFileUris, photoCreationConfigs);
      if (desFileUris.length === 0) {
        throw new Error('cancel');
      }
      // 将来源于应用沙箱的照片内容写入媒体库的目标uri
      const desFile: fileIo.File = await fileIo.open(desFileUris[0], fileIo.OpenMode.WRITE_ONLY);
      const srcFile: fileIo.File = await fileIo.open(filePath, fileIo.OpenMode.READ_ONLY | fileIo.OpenMode.NOFOLLOW);
      try {
        await fileIo.copyFile(srcFile.fd, desFile.fd);
      } finally {
        fileIo.closeSync(srcFile);
        fileIo.closeSync(desFile);
      }

      this.invokeSuccessCallback(callback, null)
    } catch (error) {
      this.invokeFailureCallback(callback, null, '保存相册失败')
      DMPLogger.e(`saveImageToPhotosAlbum failed: ${error}`);
    }
  }

  previewImage(data: DMPMap, callback: DMPBridgeCallback) {
    const urls: string[] = data.getArray<string>('urls') ?? [];
    const currentUrl: string = data.get('current');
    let index = urls.indexOf(currentUrl)
    if (index === -1) {
      index = 0
    }
    try {
      const resolvedUrls = urls.map((url: string) => this.resolvePackagedMediaPath(url));
      DRouter.getInstance()
        .build(DMPPhotoPreview.ROUTE_NAME)
        .putExtra("urls", resolvedUrls)
        .putExtra("index", index)
        .setNavMode(DMPOpenType.NavigateTo)
        .start()
      this.invokeSuccessCallback(callback, null)
    } catch (error) {
      this.invokeFailureCallback(callback, null, `previewImage:fail ${error}`);
    }
  }

  previewMedia(data: DMPMap, callback: DMPBridgeCallback) {
    const rawSources = data.getArray<Object>('sources') ?? [];
    if (rawSources.length === 0) {
      this.invokeFailureCallback(callback, null, 'previewMedia:fail sources is required');
      return;
    }
    try {
      const sources = new Array<DMPMap>();
      rawSources.forEach((source: Object) => {
        const item = new DMPMap(source);
        const url = item.getString('url') ?? '';
        if (url) {
          item.set('url', this.resolvePackagedMediaPath(url));
          const poster = item.getString('poster') ?? '';
          if (poster) {
            item.set('poster', this.resolvePackagedMediaPath(poster));
          }
          sources.push(item);
        }
      });
      if (sources.length === 0) {
        this.invokeFailureCallback(callback, null, 'previewMedia:fail invalid sources');
        return;
      }
      const current = data.getNumber('current') ?? 0;
      DRouter.getInstance()
        .build(DMPPhotoPreview.ROUTE_NAME)
        .putExtra('sources', sources)
        .putExtra('index', Math.max(0, Math.min(current, sources.length - 1)))
        .setNavMode(DMPOpenType.NavigateTo)
        .start();
      const result = new DMPMap();
      result.set('errMsg', 'previewMedia:ok');
      this.invokeSuccessCallback(callback, result, true);
    } catch (error) {
      this.invokeFailureCallback(callback, null, `previewMedia:fail ${error}`);
    }
  }

  private async resolveImagePath(src: string): Promise<string> {
    if (!src) {
      throw new Error('src is required');
    }
    if (!src.startsWith('http://') && !src.startsWith('https://')) {
      return this.resolvePackagedMediaPath(src);
    }
    const suffix = this.pathExtension(src, 'img');
    const localPath = `${this.mediaTempDirectory('remoteImage')}/image_info_${Date.now()}.${suffix}`;
    const task = await request.downloadFile(DMPContextUtils.getUIAbilityContext(), { url: src, filePath: localPath });
    await new Promise<void>((resolve, reject) => {
      task.on('complete', () => resolve());
      task.on('fail', (errorCode: number) => reject(new Error(`download failed: ${errorCode}`)));
    });
    return localPath;
  }

  private resolvePackagedMediaPath(src: string): string {
    if (src.startsWith('http://') || src.startsWith('https://')) {
      return src;
    }
    return DMPFilePathResolver.resolve(src, this.currentAppId(), this.app.bundleManager.getCurrentJSAppDir());
  }

  private mediaTempDirectory(name: string): string {
    const directory = `${DMPFilePathResolver.tempRoot(this.currentAppId())}/${name}`;
    DMPFilePathResolver.ensureDirectory(directory);
    return directory;
  }

  private pathExtension(path: string, fallback: string): string {
    const cleanPath = path.split('?')[0];
    const dot = cleanPath.lastIndexOf('.');
    return dot >= 0 ? cleanPath.substring(dot + 1).toLowerCase() : fallback;
  }

  private imageOrientation(value: string): string {
    const normalized = value.toLowerCase();
    if (normalized === '2' || normalized.includes('top-right')) return 'up-mirrored';
    if (normalized === '3' || normalized.includes('bottom-right')) return 'down';
    if (normalized === '4' || normalized.includes('bottom-left')) return 'down-mirrored';
    if (normalized === '5' || normalized.includes('left-top')) return 'left-mirrored';
    if (normalized === '6' || normalized.includes('right-top')) return 'right';
    if (normalized === '7' || normalized.includes('right-bottom')) return 'right-mirrored';
    if (normalized === '8' || normalized.includes('left-bottom')) return 'left';
    return 'up';
  }

  compressImage(data: DMPMap, callback: DMPBridgeCallback) {
    const dataQuality: number = data.get('quality');
    let url = '';
    try {
      url = this.resolvePackagedMediaPath(data.getString('src') ?? '');
      if (!fs.accessSync(url)) {
        throw new Error('invalid src');
      }
    } catch (error) {
      this.invokeFailureCallback(callback, null, `compressImage:fail ${error}`);
      return;
    }
    let quality = 80
    if (dataQuality > 0 && dataQuality < 100) {
      quality = dataQuality
    }

    const timestamp = new Date().getTime().toString();
    const localPath: string = `${this.mediaTempDirectory('compressedImage')}/${timestamp}.jpg`;
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
