import { DMPMap } from '../Utils/DMPMap';

export class DMPHttpParamsNext {
  url: string = '';
  headers: DMPMap | undefined;
  method: string = '';
  dataType: string = '';
  responseType: string = 'text';
  timeout: number = 60000;
  contentType: string = ''

  private data: DMPMap;
  body?: object | string | ArrayBuffer;
  appId: string;
  appVersion: string;

  constructor(data: DMPMap, appId: string, appVersion: string) {
    this.data = data
    this.appId = appId;
    this.appVersion = appVersion;

    this.configParamData()
  }

  canRequest(): boolean {
    if (this.url.length > 0) {
      return true;
    }
    return false
  }

  private configParamData() {
    if (this.data) {
      this.url = this.data.get('url');
      this.method = this.data.get('method') ?? 'GET';
      this.dataType = this.data.get('dataType') ?? 'json';
      this.responseType = (this.data.getString('responseType') ?? 'text').toLowerCase();
      const timeout = this.data.getNumber('timeout') ?? 60000;
      this.timeout = timeout > 0 ? timeout : 60000;
      this.body = this.data.get('data');
      this.build();
    }

  }

  public build() {
    this.method = this.method.toUpperCase()
    this.configHeaders();
  }

  private configHeaders() {
    let headerParam: object = this.data.get('header') ?? new Object()
    // 补充userAgent 和 referer 和Content-Type
    this.addCommonHeaderParams(headerParam);
    this.headers = new DMPMap(headerParam);
  }

  private addCommonHeaderParams(param: object) {
    if (!param['referer']) {
      param['referer'] = `https://servicedimina.com/${this.appId}/${this.appVersion}/page-frame.html`
    }

    let contentType: string = param['Content-Type'] ?? param['content-type']
    if (!contentType || contentType.length === 0) {
      contentType = "application/json"
    }
    this.contentType = contentType
    if (!param['Content-Type'] && !param['content-type']) param['content-type'] = contentType
  }
}