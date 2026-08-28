// Dimina Native
export const StartJsEngine: (appIndex: number,
  f: (t: number, w: number, d: string, a: ArrayBuffer) => number | string | boolean | object,
  isDebugMode: boolean,
  debuggerAddress: string,
  virtualFilePrefix: string) => number;

export const dispatchJsTask: (appIndex: number, script: string, sourceURL: string) => void;

export const dispatchJsTaskAb: (appIndex: number, ab: ArrayBuffer, sourceURL: string) => void;

export const dispatchJsTaskPath: (appIndex: number, path: string, sourceURL: string) => void;

export const destroyJsEngine: (appIndex: number) => number;

export const brotliDecompress: (data: ArrayBuffer) => ArrayBuffer;
