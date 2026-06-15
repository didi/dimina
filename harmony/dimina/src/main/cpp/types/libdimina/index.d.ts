// Dimina Native
export const StartJsEngine: (appIndex: number,
  f: (t: number, w: number, d: string, a: ArrayBuffer) => number | string | boolean | object,
  isDebugMode: boolean) => number;

export const dispatchJsTask: (appIndex: number, script: string) => void;

export const dispatchJsTaskAb: (appIndex: number, ab: ArrayBuffer) => void;

export const dispatchJsTaskPath: (appIndex: number, script: string) => void;

export const destroyJsEngine: (appIndex: number) => number;

export const brotliDecompress: (data: ArrayBuffer) => ArrayBuffer;
