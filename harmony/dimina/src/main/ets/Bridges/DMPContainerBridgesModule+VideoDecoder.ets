import { util } from '@kit.ArkTS';
import { videoDecoderOperate, videoDecoderGetFrame, videoDecoderDispose } from 'libdimina.so';
import { DMPContainerBridgesModule } from './DMPContainerBridgesModule';
import { DMPBridgeCallback } from './DMPTSUtil';
import { WorkerAppData } from '../Service/DMPSendableObjects';
import { DMPMap } from '../Utils/DMPMap';
import { DMPFileManager } from '../Bundle/Util/DMPFileManager';
import { DMPFilePathResolver } from '../Bundle/Util/DMPFilePathResolver';

export class DMPContainerBridgesModuleVideoDecoder extends DMPContainerBridgesModule {
  private disposed: boolean = false;

  constructor(app: WorkerAppData) {
    super(app);
  }

  getExportMethods(): string[] {
    return ['VideoDecoder.start', 'VideoDecoder.seek', 'VideoDecoder.stop',
      'VideoDecoder.remove', 'VideoDecoder.getFrameData'];
  }

  dispatchVideoDecoder(method: string, param: DMPMap, callback: DMPBridgeCallback): DMPMap {
    const id = param.getString('decoderId') ?? '';
    const command = method.substring('VideoDecoder.'.length);
    try {
      if (this.disposed || !id) {
        throw new Error('decoder owner disposed or missing decoderId');
      }
      if (command === 'getFrameData') {
        const frame = videoDecoderGetFrame(this.appData.appIndex, id);
        const result = new DMPMap(frame);
        if (frame.data) {
          result.set('data', { __diminaArrayBufferBase64: new util.Base64Helper().encodeToStringSync(new Uint8Array(frame.data)) });
        }
        return result;
      }
      let source = '';
      let argument = 0;
      if (command === 'start') {
        source = param.getString('source') ?? '';
        if (!source) {
          throw new Error('missing source');
        }
        argument = param.hasKey('mode') ? (param.getNumber('mode') ?? -1) : 1;
        if (!/^https?:\/\//i.test(source)) {
          const root = DMPFileManager.sharedInstance().getJSAppVersionDir(this.currentAppId(), this.appData.jsAppVersion);
          // Leading slash is a package path unless it names the app's virtual sandbox.
          try {
            source = DMPFilePathResolver.resolve(source, this.currentAppId(), root);
          } catch (error) {
            if (!source.startsWith('/')) { throw error as Error; }
            source = DMPFilePathResolver.resolve(source.replace(/^\/+/, ''), this.currentAppId(), root);
          }
        }
      } else if (command === 'seek') {
        argument = param.getNumber('position') ?? -1;
      }
      videoDecoderOperate(this.appData.appIndex, id, command, source, argument).then((value: object) => {
        if (this.disposed) { return; }
        const result = new DMPMap(value);
        result.set('errMsg', `${method}:ok`);
        this.invokeSuccessCallback(callback, result);
      }).catch((error: Error) => {
        if (!this.disposed) { this.invokeFailureCallback(callback, null, `${method}:fail ${error.message}`); }
      });
    } catch (error) {
      if (command === 'getFrameData') {
        return new DMPMap({ error: (error as Error).message });
      }
      this.invokeFailureCallback(callback, null, `${method}:fail ${(error as Error).message}`);
    }
    return new DMPMap();
  }

  dispose(): void {
    this.disposed = true;
    videoDecoderDispose(this.appData.appIndex);
  }
}
