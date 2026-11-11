import { DMPHttpParamsNext } from './DMPHttpParamsNext';
import { DMPLogger } from '../EventTrack/DMPLogger';
import { DMPMap } from '../Utils/DMPMap';
import { http } from '@kit.NetworkKit';
import { util } from '@kit.ArkTS';
import { request } from './DMPHttp';

interface DMPRequestBinary {
  __diminaArrayBufferBase64?: string;
}

export class DMPNetServiceNext {
  params: DMPHttpParamsNext;

  constructor(data: DMPMap, appId: string, appVersion: string) {
    this.params = new DMPHttpParamsNext(data, appId, appVersion);
  }

  async request(): Promise<DMPMap> {
    if (!this.params.canRequest()) throw new Error('request:fail invalid url');
    const method = this.params.method.toUpperCase();
    if (!['GET', 'HEAD', 'DELETE', 'POST', 'PUT', 'PATCH', 'OPTIONS', 'TRACE', 'CONNECT'].includes(method)) {
      throw new Error('request:fail unsupported method ' + method);
    }
    const body = ['GET', 'HEAD'].includes(method) ? undefined : this.requestBody();
    const response = await request({
      url: this.params.url,
      methodType: method as http.RequestMethod,
      body,
      headers: this.params.headers,
      responseType: this.params.responseType,
      readTimeOut: this.params.timeout,
      connectTimeout: this.params.timeout,
    });
    return this.handleResponse(response);
  }

  private requestBody(): string | ArrayBuffer | undefined {
    const body = this.params.body;
    if (body === undefined) return undefined;
    const encoded = (body as DMPRequestBinary)?.__diminaArrayBufferBase64;
    if (typeof encoded === 'string') {
      return new util.Base64Helper().decodeSync(encoded).slice().buffer;
    }
    return typeof body === 'string' ? body : JSON.stringify(body);
  }

  private handleResponse(res: http.HttpResponse): DMPMap {
    const result = new DMPMap();
    if (this.params.responseType === 'arraybuffer') {
      result.set('data', {
        __diminaArrayBufferBase64: new util.Base64Helper().encodeToStringSync(new Uint8Array(res.result as ArrayBuffer))
      });
    } else {
      const text = res.result as string;
      let value: object | string | number | boolean | null = text;
      if (this.params.dataType.toLowerCase() === 'json' && text.length > 0) {
        try { value = JSON.parse(text); } catch (_) { /* Non-JSON responses remain text. */ }
      }
      result.set('data', value);
    }
    result.set('errMsg', 'request:ok');
    result.set('statusCode', res.responseCode);
    result.set('header', new DMPMap(res.header));
    DMPLogger.d('[network]', 'response=' + result.toStr());
    return result;
  }
}
