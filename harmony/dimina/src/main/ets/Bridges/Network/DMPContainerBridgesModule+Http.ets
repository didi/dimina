
import { DMPNetServiceNext } from '../../HttpManager/DMPNetServiceNext';
import { DMPContainerBridgesModule } from '../DMPContainerBridgesModule';
import { DMPBridgeCallback, DMPBridgeCallbackType } from '../DMPTSUtil';
import { BusinessError, request } from '@kit.BasicServicesKit';
import { http } from '@kit.NetworkKit';
import { DMPMap } from '@didi-dimina/dimina/ets/Utils/DMPMap';
import { DMPContextUtils } from '../../Utils/DMPContextUtils';
import { DMPFileUrlConvertor } from '../../Bundle/Util/DMPFileUrlConvertor';
import { DMPFilePathResolver } from '../../Bundle/Util/DMPFilePathResolver';
export class DMPContainerBridgesModuleHttp extends DMPContainerBridgesModule {
  private uploadTasks: Map<string, http.HttpRequest> = new Map();
  private uploadCallbacks: Map<string, DMPBridgeCallback> = new Map();
  private settledUploadTasks: Set<string> = new Set();

  getExportMethods(): string[] {
    return ['request','downloadFile','uploadFile','uploadFileTaskAbort'];
  }

  request(data: DMPMap, callback: DMPBridgeCallback) {
    const service = new DMPNetServiceNext(data, this.appData.appId, this.appData.jsAppVersion);

    service.request()
      .then(res => {
        this.invokeSuccessCallback(callback, res)
      })
      .catch((err: Error) => {
        this.invokeFailureCallback(callback, null, err.message)
      })
  }


  getNameFromFile(path: string): string {
    if (path) {
      let names = path.split("/")
      if (names && names.length > 0) {
        return names[names.length-1]
      }
    }
    return ''
  }

  getNameFromFileName(fileName:string):string{
    if (fileName) {
      let names = fileName.split(".")
      if (names && names.length > 0) {
        return names[0]
      }
    }
    return ''
  }

  getTypeFromFile(path: string): string {
    if (path) {
      let names = path.split(".")
      if (names && names.length > 0) {
        return names[names.length-1]
      }
    }
    return ''
  }

  downloadFile(data: DMPMap, callback: DMPBridgeCallback) {
    const url: string = data.get('url')
    const context = DMPContextUtils.getUIAbilityContext()
    const timestamp = new Date().getTime().toString();
    const fileType: string = this.safeExtension(url, 'tmp')
    const directory = `${DMPFilePathResolver.tempRoot(this.currentAppId())}/downloadFile`;
    DMPFilePathResolver.ensureDirectory(directory);
    const localPath: string = `${directory}/${timestamp}.${fileType}`
    try {
      request.downloadFile(context, {
        url: url,
        filePath: localPath
      }).then((downloadTask) => {
        downloadTask.on('complete', () => {
          const tempFilePath = DMPFileUrlConvertor.vPathFromLocalPath(localPath)
          const params = new DMPMap()
          params.set('tempFilePath', tempFilePath)
          params.set('statusCode', 200)
          this.invokeSuccessCallback(callback, params)
        })
        downloadTask.on('fail', (errorCode: number) => {
          this.invokeFailureCallback(callback, null, `downloadFile:fail ${errorCode}`)
        })
      }).catch((err: BusinessError) => {
        this.invokeFailureCallback(callback, null, `downloadFile:fail ${err.message}`)
      });
    } catch (err) {
      this.invokeFailureCallback(callback, null, `downloadFile:fail ${err}`)
    }

  }

  uploadFile(param: DMPMap, callback: DMPBridgeCallback): void {
    const url = param.getString('url') ?? '';
    const virtualFilePath = param.getString('filePath') ?? '';
    const name = param.getString('name') ?? '';
    const taskId = param.getString('taskId') ?? `${Date.now()}`;
    const progressCallbackId = param.getString('progressCallback') ?? '';
    const headersCallbackId = param.getString('headersCallback') ?? '';
    const requestedTimeout = param.getNumber('timeout') ?? 60000;
    const timeout = requestedTimeout > 0 ? requestedTimeout : 60000;

    this.uploadCallbacks.set(taskId, callback);
    if (!url || !virtualFilePath || !name) {
      this.finishUpload(taskId, callback, false, 'uploadFile:fail missing required parameters');
      return;
    }

    try {
      const filePath = DMPFilePathResolver.resolve(
        virtualFilePath, this.currentAppId(), this.app.bundleManager.getCurrentJSAppDir());
      const fileName = this.getNameFromFile(filePath);
      const multiFormDataList: Array<http.MultiFormData> = [];
      const rawFormData: object | undefined = param.getObject('formData');
      if (rawFormData) {
        DMPMap.toMap<string, object>(rawFormData).forEach((value: object, key: string) => {
          multiFormDataList.push({
            name: key,
            contentType: 'text/plain; charset=utf-8',
            data: String(value)
          });
        });
      }
      multiFormDataList.push({
        name: name,
        contentType: 'application/octet-stream',
        remoteFileName: fileName,
        filePath: filePath
      });

      const headerMap = new DMPMap(param.getObject('header'));
      let hasContentType = false;
      headerMap.toMap<string, string>().forEach((_value: string, key: string) => {
        if (key.toLowerCase() === 'content-type') {
          hasContentType = true;
          headerMap.set(key, 'multipart/form-data');
        }
      });
      if (!hasContentType) {
        headerMap.set('Content-Type', 'multipart/form-data');
      }

      const uploadRequest = http.createHttp();
      this.uploadTasks.set(taskId, uploadRequest);
      uploadRequest.on('dataSendProgress', (progressInfo: http.DataSendProgressInfo) => {
        if (this.settledUploadTasks.has(taskId)) {
          return;
        }
        const progress = progressInfo.totalSize > 0
          ? Math.min(100, Math.max(0, Math.floor(progressInfo.sendSize * 100 / progressInfo.totalSize)))
          : 0;
        this.emitUploadEvent(callback, progressCallbackId, new DMPMap({
          progress: progress,
          totalBytesSent: progressInfo.sendSize,
          totalBytesExpectedToSend: progressInfo.totalSize
        }));
      });
      uploadRequest.on('headersReceive', (headers: object) => {
        if (!this.settledUploadTasks.has(taskId)) {
          this.emitUploadEvent(callback, headersCallbackId, new DMPMap({ header: headers }));
        }
      });

      const uploadOptions: http.HttpRequestOptions = {
        method: http.RequestMethod.POST,
        header: headerMap.toObject<object>(),
        multiFormDataList: multiFormDataList,
        expectDataType: http.HttpDataType.STRING,
        usingCache: false,
        readTimeout: timeout,
        connectTimeout: timeout
      };
      uploadRequest.request(url, uploadOptions)
        .then((response: http.HttpResponse) => {
          const responseData = typeof response.result === 'string'
            ? response.result
            : String(response.result);
          this.finishUpload(taskId, callback, true, 'uploadFile:ok',
            Number(response.responseCode), responseData);
        })
        .catch((error: BusinessError) => {
          if (this.settledUploadTasks.has(taskId)) {
            this.settledUploadTasks.delete(taskId);
            return;
          }
          this.finishUpload(taskId, callback, false, `uploadFile:fail ${error.message}`);
        });
    } catch (error) {
      this.finishUpload(taskId, callback, false, `uploadFile:fail ${String(error)}`);
    }
  }

  private safeExtension(path: string, fallback: string): string {
    const cleanPath = path.split('?')[0].split('#')[0];
    const dotIndex = cleanPath.lastIndexOf('.');
    const extension = dotIndex >= 0 ? cleanPath.substring(dotIndex + 1).toLowerCase() : '';
    return /^[a-z0-9]{1,10}$/.test(extension) ? extension : fallback;
  }

  uploadFileTaskAbort(param: DMPMap, _callback: DMPBridgeCallback): void {
    const taskId = param.getString('taskId') ?? '';
    if (!taskId || this.settledUploadTasks.has(taskId)) {
      return;
    }
    const task = this.uploadTasks.get(taskId);
    const callback = this.uploadCallbacks.get(taskId);
    if (callback) {
      this.finishUpload(taskId, callback, false, 'uploadFile:fail abort', 0, '', true);
    }
    task?.destroy();
    setTimeout(() => this.settledUploadTasks.delete(taskId), 5000);
  }

  private emitUploadEvent(callback: DMPBridgeCallback, callbackId: string, payload: DMPMap): void {
    if (callbackId) {
      callback(payload, DMPBridgeCallbackType.Success, callbackId);
    }
  }

  private finishUpload(taskId: string, callback: DMPBridgeCallback, success: boolean, errMsg: string,
    statusCode: number = 0, responseData: string = '', keepSettled: boolean = false): void {
    if (this.settledUploadTasks.has(taskId)) {
      return;
    }
    this.settledUploadTasks.add(taskId);
    const task = this.uploadTasks.get(taskId);
    this.uploadTasks.delete(taskId);
    this.uploadCallbacks.delete(taskId);

    const result = success
      ? new DMPMap({ data: responseData, statusCode: statusCode, errMsg: errMsg })
      : new DMPMap({ errMsg: errMsg });
    callback(result, success ? DMPBridgeCallbackType.Success : DMPBridgeCallbackType.Fail);
    callback(result, DMPBridgeCallbackType.Complete);
    if (!keepSettled) {
      task?.destroy();
    }

    if (!keepSettled) {
      Promise.resolve(true).then(() => this.settledUploadTasks.delete(taskId));
    }
  }
}
