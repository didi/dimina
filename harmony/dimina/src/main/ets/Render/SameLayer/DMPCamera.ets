import { BusinessError } from '@kit.BasicServicesKit';
import { camera } from '@kit.CameraKit';
import { image } from '@kit.ImageKit';
import { DMPContextUtils } from '../../Utils/DMPContextUtils';
import { DMPLogger } from '../../EventTrack/DMPLogger';

class CommonConstants {
  /**
   * The device outputs the sequence number.
   */
  static readonly OUTPUT_DEVICE_INDEX: number = 23; // 1920 * 1080
  /**
   * The device inputs the sequence number.
   */
  static readonly INPUT_DEVICE_INDEX: number = 0;
  /**
   * The width of the image receiving stream.
   */
  static readonly IMAGE_RECEIVER_WIDTH: number = 1920;
  /**
   * The height of the image receiving stream.
   */
  static readonly IMAGE_RECEIVER_HEIGHT: number = 1080;
  /**
   * The capacity of the image receiving stream.
   */
  static readonly IMAGE_RECEIVER_CAPACITY: number = 8;
  /**
   * The size of full width.
   */
  static readonly FULL_WIDTH: string = "100%";
  /**
   * The size of full height.
   */
  static readonly FULL_Height: string = "100%";
  /**
   * The true number.
   */
  static readonly TRUE_NUMBER: number = 1;
  /**
   * The false number.
   */
  static readonly FALSE_NUMBER: number = 0;
  /**
   * The width of surface.
   */
  static readonly SURFACE_WIDTH: number = 190;
  /**
   * The height of surface.
   */
  static readonly SURFACE_HEIGHT: number = 100;
  /**
   * The type of xcomponent.
   */
  static readonly XCOMPONENT_TYPE: string = 'surface';
  /**
   * The id of xcomponent.
   */
  static readonly XCOMPONENT_ID: string = 'xcomponent1';
}

export const TAG: string = '[CameraModel]';

export default class DMPCamera {
  private cameraMgr: camera.CameraManager | undefined = undefined;
  private cameraDevice: camera.CameraDevice | undefined = undefined;
  private capability: camera.CameraOutputCapability | undefined = undefined;
  private cameraInput: camera.CameraInput | undefined = undefined;
  public previewOutput: camera.PreviewOutput | undefined = undefined;
  private receiver: image.ImageReceiver | undefined = undefined;
  private photoSurfaceId: string | undefined = undefined;
  private photoOutput: camera.PhotoOutput | undefined = undefined;
  private captureSession: camera.CaptureSession | undefined = undefined;
  public photoOutputCb: Function | undefined = undefined;
  private static instance: DMPCamera

  public static sharedInstance(): DMPCamera {
    if (!DMPCamera.instance) {
      DMPCamera.instance = new DMPCamera()
    }
    return DMPCamera.instance
  }


  async initCamera(surfaceId: string): Promise<void> {
    // 创建CameraManager对象
    this.cameraMgr = camera.getCameraManager(DMPContextUtils.getUIAbilityContext());

    // 监听相机状态变化
    this.cameraMgr.on('cameraStatus', (err: BusinessError, cameraStatusInfo: camera.CameraStatusInfo) => {
      DMPLogger.i(TAG, `camera : ${cameraStatusInfo.camera.cameraId}`);
      DMPLogger.i(TAG, `status: ${cameraStatusInfo.status}`);
    });

    let cameraArray = this.getCameraDevices(this.cameraMgr);
    for (let index = 0; index < cameraArray.length; index++) {
      DMPLogger.i(TAG, 'cameraId : ' + cameraArray[index].cameraId); // 获取相机ID
      DMPLogger.i(TAG, 'cameraPosition : ' + cameraArray[index].cameraPosition); // 获取相机位置
      DMPLogger.i(TAG, 'cameraType : ' + cameraArray[index].cameraType); // 获取相机类型
      DMPLogger.i(TAG, 'connectionType : ' + cameraArray[index].connectionType); // 获取相机连接类型
    }

    this.cameraDevice = cameraArray[CommonConstants.INPUT_DEVICE_INDEX];
    this.cameraInput = this.getCameraInput(this.cameraDevice, this.cameraMgr) as camera.CameraInput;
    await this.cameraInput.open();
    this.capability = this.cameraMgr.getSupportedOutputCapability(this.cameraDevice, camera.SceneMode.NORMAL_PHOTO);

    // Preview output stream
    this.previewOutput = this.getPreviewOutput(this.cameraMgr, this.capability, surfaceId) as camera.PreviewOutput;

    // Photo output stream
    let size: image.Size = {
      height: CommonConstants.IMAGE_RECEIVER_HEIGHT,
      width: CommonConstants.IMAGE_RECEIVER_WIDTH
    }
    this.receiver = image.createImageReceiver(size, image.ImageFormat.JPEG, CommonConstants.IMAGE_RECEIVER_CAPACITY);
    this.photoSurfaceId = await this.getImageReceiverSurfaceId(this.receiver) as string;
    this.photoOutput = this.getPhotoOutput(this.cameraMgr, this.capability, this.photoSurfaceId) as camera.PhotoOutput;
    // this.receiver!.on('imageArrival', this.imgReceive = async () => {
    //   let receiverImage = await this.receiver!.readLatestImage();
    //   let buffer = new ArrayBuffer(CommonConstants.ARRAYBUFFER_SIZE);
    //   let img = await receiverImage.getComponent(image.ComponentType.JPEG);
    //   buffer = img!.byteBuffer;
    //   await this.previewOutput!.stop();
    //   // this.result = await this.recognizeImage(buffer);
    //
    //   if (this.photoOutputCb) {
    //     this.photoOutputCb(buffer)
    //   }
    //
    //   await receiverImage.release();
    // })

    //设置回调之后，调用photoOutput的capture方法，就会将拍照的buffer回传到回调中
    this.photoOutput.on('photoAvailable', (errCode: BusinessError, photo: camera.Photo): void => {
      DMPLogger.i(TAG, 'getPhoto start');
      DMPLogger.i(TAG, `err: ${JSON.stringify(errCode)}`);
      if (errCode || photo === undefined) {
         DMPLogger.e('getPhoto failed');
        return;
      }
      let imageObj = photo.main;
      imageObj.getComponent(image.ComponentType.JPEG, (errCode: BusinessError, component: image.Component): void => {
        DMPLogger.i(TAG, 'getComponent start');
        if (errCode || component === undefined) {
          DMPLogger.e('getComponent failed');
          return;
        }
        let buffer: ArrayBuffer;
        if (component.byteBuffer) {
          buffer = component.byteBuffer;

          if (this.photoOutputCb) {
            this.photoOutputCb(buffer)
          }
        } else {
           DMPLogger.e('byteBuffer is null');
          return;
        }
        // savePicture(buffer, imageObj);
      });
    });

    // Session Init
    this.captureSession = this.getCaptureSession(this.cameraMgr) as camera.CaptureSession;
    this.beginConfig(this.captureSession);
    this.startSession(this.captureSession, this.cameraInput, this.previewOutput, this.photoOutput);
  }

  async takePicture() {
    // let photoCaptureSetting: camera.PhotoCaptureSetting = {
    //   quality: camera.QualityLevel.QUALITY_LEVEL_HIGH, // 设置图片质量高
    //   rotation: camera.ImageRotation.ROTATION_0 // 设置图片旋转角度0
    // }
    // this.photoOutput!.capture(photoCaptureSetting);
    this.photoOutput!.capture();
  }


  async releaseCamera(): Promise<void> {
    if (this.cameraInput) {
      await this.cameraInput.close();
      DMPLogger.i(TAG, 'cameraInput release');
    }
    if (this.previewOutput) {
      await this.previewOutput.release();
      DMPLogger.i(TAG, 'previewOutput release');
    }
    if (this.receiver) {
      await this.receiver.release();
      DMPLogger.i(TAG, 'receiver release');
    }
    if (this.photoOutput) {
      await this.photoOutput.release();
      DMPLogger.i(TAG, 'photoOutput release');
    }
    if (this.captureSession) {
      await this.captureSession.release();
      DMPLogger.i(TAG, 'captureSession release');
      this.captureSession = undefined;
    }
  }

  getCameraDevices(cameraManager: camera.CameraManager): Array<camera.CameraDevice> {
    let cameraArray: Array<camera.CameraDevice> = cameraManager.getSupportedCameras();
    if (cameraArray != undefined && cameraArray.length > 0) {
      return cameraArray;
    } else {
       DMPLogger.e(TAG, `getSupportedCameras faild`);
      return [];
    }
  }

  getCameraInput(cameraDevice: camera.CameraDevice, cameraManager: camera.CameraManager): camera.CameraInput | undefined {
    let cameraInput: camera.CameraInput | undefined = undefined;

    try {
      cameraInput = cameraManager.createCameraInput(cameraDevice);
    } catch (error) {
      let err = error as BusinessError;
       DMPLogger.e('Failed to createCameraInput errorCode = ' + err.code);
    }

    // cameraInput = cameraManager.createCameraInput(cameraDevice);
    return cameraInput;


  }

  getPreviewOutput(cameraManager: camera.CameraManager, cameraOutputCapability: camera.CameraOutputCapability,
                   surfaceId: string): camera.PreviewOutput | undefined {
    let previewProfilesArray: Array<camera.Profile> = cameraOutputCapability.previewProfiles;
    let previewOutput: camera.PreviewOutput | undefined = undefined;
    previewOutput = cameraManager.createPreviewOutput(previewProfilesArray[CommonConstants.OUTPUT_DEVICE_INDEX], surfaceId);
    return previewOutput;
  }

  async startPreviewOutput(previewOutput: camera.PreviewOutput): Promise<void> {
    previewOutput.start().then(() => {
      DMPLogger.i(TAG, `previewOutput start success`);
    }).catch((err: BusinessError) => {
       DMPLogger.e(TAG, `previewOutput start faild errorCode =  ${err.code}`);
    });
  }

  async getImageReceiverSurfaceId(receiver: image.ImageReceiver): Promise<string | undefined> {
    let photoSurfaceId: string | undefined = undefined;
    if (receiver !== undefined) {
      photoSurfaceId = await receiver.getReceivingSurfaceId();
      DMPLogger.i(TAG, `getReceivingSurfaceId success`);
    }
    return photoSurfaceId;
  }

  getPhotoOutput(cameraManager: camera.CameraManager, cameraOutputCapability: camera.CameraOutputCapability,
                 photoSurfaceId: string): camera.PhotoOutput | undefined {
    let photoProfilesArray: Array<camera.Profile> = cameraOutputCapability.photoProfiles;
    if (!photoProfilesArray) {
      DMPLogger.i(TAG, `createOutput photoProfilesArray == null || undefined`);
    }
    let photoOutput: camera.PhotoOutput | undefined = undefined;
    try {
      // photoOutput = cameraManager.createPhotoOutput(photoProfilesArray[CommonConstants.OUTPUT_DEVICE_INDEX], photoSurfaceId);
      photoOutput = cameraManager.createPhotoOutput(photoProfilesArray[CommonConstants.OUTPUT_DEVICE_INDEX]);
    } catch (error) {
       DMPLogger.e(TAG, `Failed to createPhotoOutput. error: ${JSON.stringify(error as BusinessError)}`);
    }
    return photoOutput;
  }

  getCaptureSession(cameraManager: camera.CameraManager): camera.CaptureSession | undefined {
    let captureSession: camera.CaptureSession | undefined = undefined;
    // let captureSession: camera.VideoSession | undefined = undefined;
    try {
      captureSession = cameraManager.createCaptureSession();
      // captureSession = cameraManager.createSession();
    } catch (error) {
       DMPLogger.e(TAG, `Failed to create the CaptureSession instance. error: ${JSON.stringify(error as BusinessError)}`);
    }
    return captureSession;
  }

  beginConfig(captureSession: camera.CaptureSession): void {
    try {
      captureSession.beginConfig();
    } catch (error) {
       DMPLogger.e(TAG, `Failed to beginConfig. error: ${JSON.stringify(error as BusinessError)}`);
    }
  }

  async startSession(captureSession: camera.CaptureSession, cameraInput: camera.CameraInput, previewOutput:
    camera.PreviewOutput, photoOutput: camera.PhotoOutput): Promise<void> {
    captureSession.addInput(cameraInput);
    captureSession.addOutput(previewOutput);
    captureSession.addOutput(photoOutput);
    await captureSession.commitConfig();
    await captureSession.start();
  }
}
