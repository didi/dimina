import { http } from "@kit.NetworkKit"
import { DMPMap } from "../Utils/DMPMap";

export async function request(option: DMPRequestOption): Promise<http.HttpResponse> {
  let options: http.HttpRequestOptions = {
    method: option.methodType,
    extraData: option.body, //body string
    expectDataType: option.responseType === 'arraybuffer' ? http.HttpDataType.ARRAY_BUFFER : http.HttpDataType.STRING,
    usingCache: false,
    header: option.headers?.toJSON(),
    readTimeout: option.readTimeOut,
    connectTimeout: option.connectTimeout,
    usingProxy: false,
    caPath: undefined
  }
  const transport = http.createHttp();
  try {
    return await transport.request(option.url, options);
  } finally {
    transport.destroy();
  }

}

export interface DMPRequestOption {
  headers?: DMPMap;
  body?: string | ArrayBuffer;
  responseType?: string;
  url: string;
  methodType: http.RequestMethod
  readTimeOut?: number
  connectTimeout?: number
}