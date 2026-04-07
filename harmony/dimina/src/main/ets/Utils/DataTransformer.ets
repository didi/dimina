import { DMPMap } from './DMPMap'

export class DataTransformer {

  private static decodeLoop(source: string): string {
    if (/%/.test(source)) {
      const newRes = decodeURIComponent(source)
      return DataTransformer.decodeLoop(newRes)
    }
    return source
  }

  static eventContainerToWebView(method: string, params: Map<string, object>, webViewId: number | undefined): DMPMap {
    const backDic = new DMPMap()
    const result = new DMPMap()
    result.set('data', params ?? {})
    if (webViewId && webViewId > 0) {
      result.set('webViewId', webViewId)
    }
    backDic.set('payload', result.toJSON())
    backDic.set('event', method)
    const msg: DMPMap = new DMPMap({
      type: 'triggerCallback',
      body: {
        args: backDic.toJSON(),
        id: method
      }
    })
    return msg
  }

  /**
   * 解析url
   * @param url
   * @returns
   */
  static parse(url: string): DMPMap {
    const decodeUrl = url
    const firstIndex = decodeUrl.indexOf('?') > 0 ? decodeUrl.indexOf('?') : decodeUrl.length

    let pagePath = decodeUrl.slice(0, firstIndex);
    if (pagePath.startsWith('/') && pagePath.length > 0) {
      pagePath = pagePath.substring(1)
    }
    const paramStr = decodeUrl.slice(firstIndex + 1);
    const query = new DMPMap()
    const result = new DMPMap({ query, pagePath });
    const paramArray = paramStr.split('&')

    paramArray.forEach((param) => {
      const firstIndex = param.indexOf('=') > 0 ? param.indexOf('=') : param.length
      let key = param.slice(0, firstIndex);
      let value = param.slice(firstIndex + 1)
      const decodeValue = DataTransformer.decodeLoop(value)
      result.get('query').set(key, decodeValue)
    })
    return result;
  }
}