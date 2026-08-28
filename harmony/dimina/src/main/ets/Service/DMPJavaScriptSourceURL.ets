export class DMPJavaScriptSourceURL {
  static readonly SDK_SERVICE: string = '/__dimina__/sdk/service.js';

  static appLogic(appId: string, root: string): string {
    const appSegment = DMPJavaScriptSourceURL.safeSegment(appId);
    const rootSegments = root.split('/').filter((segment: string) => segment.length > 0);
    const safeRoot = rootSegments
      .map((segment: string) => DMPJavaScriptSourceURL.safeSegment(segment))
      .join('/') || 'main';
    return `/__dimina__/${appSegment}/${safeRoot}/logic.js`;
  }

  static runtimeEval(appId: string): string {
    return `/__dimina__/${DMPJavaScriptSourceURL.safeSegment(appId)}/runtime/eval.js`;
  }

  private static safeSegment(value: string): string {
    const safe = value.replace(/[^A-Za-z0-9._-]/g, '_');
    if (safe.length === 0 || safe === '.' || safe === '..') {
      return 'unknown';
    }
    return safe;
  }
}
