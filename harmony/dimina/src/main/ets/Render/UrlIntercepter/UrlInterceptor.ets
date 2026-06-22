import { DMPFileUrlConvertor } from '../../Bundle/Util/DMPFileUrlConvertor';
import { DMPAppManager } from '../../DApp/DMPAppManager';
import fs from '@ohos.file.fs';
import { DMPLogger } from '../../EventTrack/DMPLogger';
import { Tags } from '../../EventTrack/Tags';
import { DMPApp } from '../../DApp/DMPApp';

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
      if (url.startsWith('difile://')) {
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

  private static isWebResourceRequest(url: string): boolean {
    const path = RequestCallback.getUrlPath(url);
    return path.endsWith('.js') || path.endsWith('.css') || path.endsWith('.html') || path.endsWith('.png') ||
    path.endsWith('.jpg') || path.endsWith('.ico') || path.endsWith('.jpeg') || path.endsWith('.webp') ||
    path.endsWith('.gif') || path.endsWith('.svg') || path.endsWith('.json');
  }

  private static handleWebResourceRequest(url: string, app: DMPApp): WebResourceResponse | null {
    const sandboxFilePath = RequestCallback.getSandboxFilePath(url, app);
    if (!RequestCallback.hasFile(sandboxFilePath)) {
      DMPLogger.d(Tags.WEB_COMPONENT, `${sandboxFilePath} 不存在`);
      return null;
    }
    DMPLogger.d(Tags.WEB_COMPONENT, `${sandboxFilePath}`);
    const response = RequestCallback.buildResponse(sandboxFilePath);
    const extension = RequestCallback.getFileExtension(sandboxFilePath);
    RequestCallback.setResponseMimeType(response, extension);
    return response;
  }

  private static handleDIFileRequest(url: string, app: DMPApp): WebResourceResponse | null {
    const filePath = DMPFileUrlConvertor.localPathFromVPath(url);
    if (filePath == null || !RequestCallback.hasFile(filePath)) {
      return null;
    }
    const response = RequestCallback.buildResponse(filePath);
    response.setResponseMimeType('image/*');
    return response;
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
    switch (extension) {
      case 'html':
        response.setResponseMimeType('text/html');
        break;
      case 'js':
        response.setResponseMimeType('text/javascript');
        break;
      case 'css':
        response.setResponseMimeType('text/css');
        break;
      case 'json':
        response.setResponseMimeType('application/json');
        break;
      case 'png':
        response.setResponseMimeType('image/png');
        break;
      case 'jpg':
      case 'jpeg':
        response.setResponseMimeType('image/jpeg');
        break;
      case 'webp':
        response.setResponseMimeType('image/webp');
        break;
      case 'gif':
        response.setResponseMimeType('image/gif');
        break;
      case 'svg':
        response.setResponseMimeType('image/svg+xml');
        break;
      case 'ico':
        response.setResponseMimeType('image/x-icon');
        break;
      default:
        DMPLogger.e(Tags.WEB_COMPONENT, `未适配(${extension}类型)资源加载`);
        response.setResponseMimeType('application/octet-stream');
        break;
    }
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
