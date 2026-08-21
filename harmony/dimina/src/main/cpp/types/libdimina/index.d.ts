// Dimina Native
export const StartJsEngine: (appIndex: number,
  f: (t: number, w: number, d: string, a: ArrayBuffer) => number | string | boolean | object,
  isDebugMode: boolean) => number;

export const dispatchJsTask: (appIndex: number, script: string) => void;

export const dispatchJsTaskAb: (appIndex: number, ab: ArrayBuffer) => void;

export const dispatchJsTaskPath: (appIndex: number, script: string) => void;

export const destroyJsEngine: (appIndex: number) => number;

export const brotliDecompress: (data: ArrayBuffer) => ArrayBuffer;

// Canvas threadsafe function for QuickJS → main-thread communication
export const registerCanvasTsfn: (appIndex: number, callback: (type: number, data: string) => string) => void;

// Canvas 2D GL surface binding
// canvasBindSurface returns a bind generation number; pass it to canvasUnbindSurface for ownership check
export const canvasBindSurface: (appIndex: number, nodeId: string, surfaceId: string, width: number, height: number, dpr?: number) => number;
export const canvasUnbindSurface: (appIndex: number, nodeId: string, bindGeneration?: number) => number;
export const canvasResizeSurface: (appIndex: number, nodeId: string, width: number, height: number) => number;

// Upload decoded image pixels to GL canvas (called after network image download)
export const canvasUploadImage: (appIndex: number, nodeId: string, imageId: string, pixelBuffer: ArrayBuffer, width: number, height: number, onloadCallbackId: string) => number;
