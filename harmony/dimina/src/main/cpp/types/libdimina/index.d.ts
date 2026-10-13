// Dimina Native
export const StartJsEngine: (appIndex: number,
  f: (t: number, w: number, d: string | object, a: ArrayBuffer) => number | string | boolean | object,
  isDebugMode: boolean,
  debuggerAddress: string,
  virtualFilePrefix: string) => number;

export const dispatchJsTask: (appIndex: number, script: string, sourceURL: string) => void;

export const dispatchJsTaskAb: (appIndex: number, ab: ArrayBuffer, sourceURL: string) => void;
export const dispatchMessage: (appIndex: number, message: object) => void;

export const dispatchJsTaskPath: (appIndex: number, path: string, sourceURL: string) => void;

export const destroyJsEngine: (appIndex: number) => number;

export const brotliDecompress: (data: ArrayBuffer) => ArrayBuffer;

export interface VideoDecoderFrame {
  width?: number;
  height?: number;
  pts?: number;
  pkPts?: number;
  data?: ArrayBuffer;
  ended?: boolean;
  error?: string;
}
export const videoDecoderOperate: (owner: number, id: string, command: string,
  source: string, argument: number) => Promise<object>;
export const videoDecoderGetFrame: (owner: number, id: string) => VideoDecoderFrame;
export const videoDecoderDispose: (owner: number) => void;

export const canvasUiRegister: (owner: number, page: number, callback: (requestId: string, script: string) => void) => string;
export const canvasUiUnregister: (owner: number, page: number, token: string) => void;
export const canvasUiPublish: (owner: number, page: number, script: string) => boolean;
export const canvasUiComplete: (requestId: string, feedback: string, error: string) => void;
