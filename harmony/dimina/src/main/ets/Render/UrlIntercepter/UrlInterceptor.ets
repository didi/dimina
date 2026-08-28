import { DMPAppManager } from '../../DApp/DMPAppManager';
import fs from '@ohos.file.fs';
import { DMPLogger } from '../../EventTrack/DMPLogger';
import { Tags } from '../../EventTrack/Tags';
import { DMPApp } from '../../DApp/DMPApp';
import image from '@ohos.multimedia.image';
import { DMPFilePathResolver } from '../../Bundle/Util/DMPFilePathResolver';
import { DMPFileURLScheme } from '../../Bundle/Util/DMPFileUrlConvertor';

interface InterceptRequestEvent {
  request: WebResourceRequest;
}

export class RequestCallback {
  appIndex: number

  constructor(appIndex: number) {
    this.appIndex = appIndex;
  }

  callback(event?: InterceptRequestEvent) {
    const app = DMPAppManager.sharedInstance().getApp(this.appIndex)
    if (event && app) {
      const url = event.request.getRequestUrl();
      DMPLogger.d(Tags.LAUNCH, "webview onInterceptRequest url=" + url);
      DMPLogger.d(Tags.WEB_COMPONENT, "url=" + url);
      if (url.startsWith(DMPFileURLScheme)) {
        return RequestCallback.handleDIFileRequest(url, app);
      }
      if (RequestCallback.isWebResourceRequest(url)) {
        return RequestCallback.handleWebResourceRequest(url, app);
      } else {
        return null;
      }
    }

    return null;
  }

  static isWebResourceRequest(url: string): boolean {
    const path = RequestCallback.getUrlPath(url).toLowerCase();
    return path.endsWith('.js') || path.endsWith('.css') || path.endsWith('.html') || path.endsWith('.png') ||
    path.endsWith('.jpg') || path.endsWith('.ico') || path.endsWith('.jpeg') || path.endsWith('.webp') ||
    path.endsWith('.gif') || path.endsWith('.svg') || path.endsWith('.heic') || path.endsWith('.heif') ||
    path.endsWith('.json');
  }

  private static handleWebResourceRequest(url: string, app: DMPApp): WebResourceResponse | null {
    const sandboxFilePath = RequestCallback.getSandboxFilePath(url, app);
    if (!RequestCallback.hasFile(sandboxFilePath)) {
      DMPLogger.d(Tags.WEB_COMPONENT, `${sandboxFilePath} 不存在`);
      return null;
    }
    DMPLogger.d(Tags.WEB_COMPONENT, `${sandboxFilePath}`);
    const extension = RequestCallback.getFileExtension(sandboxFilePath);
    if (RequestCallback.requiresHeifTranscode(extension)) {
      return RequestCallback.buildHeifResponse(sandboxFilePath);
    }
    const response = RequestCallback.buildResponse(sandboxFilePath);
    RequestCallback.setResponseMimeType(response, extension);
    return response;
  }

  private static handleDIFileRequest(url: string, app: DMPApp): WebResourceResponse | null {
    let filePath = '';
    try {
      filePath = DMPFilePathResolver.resolve(
        url,
        app.appConfig.appId,
        app.bundleManager.getCurrentJSAppDir()
      );
    } catch (error) {
      DMPLogger.w(Tags.WEB_COMPONENT, `Rejected difile request ${url}: ${(error as Error).message}`);
      return null;
    }
    if (!RequestCallback.hasFile(filePath)) {
      return null;
    }
    const extension = RequestCallback.getFileExtension(filePath);
    if (RequestCallback.requiresHeifTranscode(extension)) {
      return RequestCallback.buildHeifResponse(filePath);
    }
    const response = RequestCallback.buildResponse(filePath);
    response.setResponseMimeType(RequestCallback.mimeTypeForExtension(extension, 'image/*'));
    return response;
  }

  private static buildHeifResponse(filePath: string): WebResourceResponse {
    const response = new WebResourceResponse();
    response.setResponseCode(200);
    response.setReasonMessage('OK');
    response.setResponseMimeType('image/jpeg');
    response.setResponseIsReady(false);

    let imageSourceApi: image.ImageSource | undefined = undefined;
    let imagePackerApi: image.ImagePacker | undefined = undefined;
    try {
      imageSourceApi = image.createImageSource(filePath);
      imagePackerApi = image.createImagePacker();
      const packOptions: image.PackingOption = { format: 'image/jpeg', quality: 100 };
      imagePackerApi.packing(imageSourceApi, packOptions).then((data: ArrayBuffer) => {
        response.setResponseData(data);
        RequestCallback.releaseHeifResources(imageSourceApi, imagePackerApi);
        response.setResponseIsReady(true);
      }).catch((error: Error) => {
        RequestCallback.releaseHeifResources(imageSourceApi, imagePackerApi);
        RequestCallback.failHeifResponse(response, filePath, error.message);
      });
    } catch (error) {
      RequestCallback.releaseHeifResources(imageSourceApi, imagePackerApi);
      RequestCallback.failHeifResponse(response, filePath, (error as Error).message);
    }

    return response;
  }

  private static releaseHeifResources(imageSourceApi: image.ImageSource | undefined,
    imagePackerApi: image.ImagePacker | undefined): void {
    try {
      imageSourceApi?.release();
    } catch (error) {
      DMPLogger.e(Tags.WEB_COMPONENT, `HEIF ImageSource释放失败: ${(error as Error).message}`);
    }
    try {
      imagePackerApi?.release();
    } catch (error) {
      DMPLogger.e(Tags.WEB_COMPONENT, `HEIF ImagePacker释放失败: ${(error as Error).message}`);
    }
  }

  private static failHeifResponse(response: WebResourceResponse, filePath: string, message: string): void {
    DMPLogger.e(Tags.WEB_COMPONENT, `HEIF资源解码失败 path=${filePath}, error=${message}`);
    response.setResponseData(new ArrayBuffer(0));
    response.setResponseCode(500);
    response.setReasonMessage('HEIF Decode Failed');
    response.setResponseIsReady(true);
  }

  private static buildResponse(filePath: string): WebResourceResponse {
    const file = fs.openSync(filePath, fs.OpenMode.READ_ONLY);
    const response = new WebResourceResponse();
    response.setResponseData(file.fd);
    response.setResponseCode(200);
    response.setReasonMessage('OK');
    response.setResponseIsReady(true);
    response.setResponseEncoding('utf-8');
    return response;
  }

  private static setResponseMimeType(response: WebResourceResponse, extension: string): void {
    const mimeType = RequestCallback.mimeTypeForExtension(extension);
    if (mimeType === 'application/octet-stream') {
      DMPLogger.e(Tags.WEB_COMPONENT, `未适配(${extension}类型)资源加载`);
    }
    response.setResponseMimeType(mimeType);
  }

  static mimeTypeForExtension(extension: string, fallback: string = 'application/octet-stream'): string {
    switch (extension) {
      case 'html':
        return 'text/html';
      case 'js':
        return 'text/javascript';
      case 'css':
        return 'text/css';
      case 'json':
        return 'application/json';
      case 'png':
        return 'image/png';
      case 'jpg':
      case 'jpeg':
        return 'image/jpeg';
      case 'webp':
        return 'image/webp';
      case 'gif':
        return 'image/gif';
      case 'svg':
        return 'image/svg+xml';
      case 'ico':
        return 'image/x-icon';
      case 'heic':
        return 'image/heic';
      case 'heif':
        return 'image/heif';
      default:
        return fallback;
    }
  }

  static requiresHeifTranscode(extension: string): boolean {
    const normalizedExtension = extension.toLowerCase();
    return normalizedExtension === 'heic' || normalizedExtension === 'heif';
  }

  private static getSandboxFilePath(url: string, app: DMPApp): string {
    const bundleManager = app!.bundleManager;
    const bundleInfo = bundleManager.getBundleInfo();
    const appId = bundleInfo.appId;
    const path = RequestCallback.getUrlPath(url);
    if (path.startsWith('http://127.0.0.1/')) {
      const isFromAppBundle = path.includes(appId);
      const processUrl = isFromAppBundle
        ? path.replace(`http://127.0.0.1/${appId}/`, '')
        : path.replace('http://127.0.0.1/', '');
      const sandboxDir = isFromAppBundle
        ? bundleManager.getCurrentJSAppDir()
        : bundleManager.getCurrentJSSdkDir();

      return `${sandboxDir}/${processUrl}`;
    } else {
      //debugUrl 不处理
      return url;
    }
  }

  private static getFileExtension(filePath: string): string {
    const parts = filePath.split('.');
    return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : '';
  }

  private static getUrlPath(url: string): string {
    let endIndex = url.length;
    const queryIndex = url.indexOf('?');
    if (queryIndex >= 0 && queryIndex < endIndex) {
      endIndex = queryIndex;
    }
    const fragmentIndex = url.indexOf('#');
    if (fragmentIndex >= 0 && fragmentIndex < endIndex) {
      endIndex = fragmentIndex;
    }
    return url.substring(0, endIndex);
  }

  private static hasFile(filePath: string): boolean {
    return fs.accessSync(filePath);
  }
}
