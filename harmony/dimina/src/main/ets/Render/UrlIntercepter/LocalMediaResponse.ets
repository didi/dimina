import fs from '@ohos.file.fs'
import { DMPFilePathResolver } from '../../Bundle/Util/DMPFilePathResolver'

export const LOCAL_MEDIA_URL: string = 'http://127.0.0.1/__dimina_media'
const SOURCE_QUERY: string = LOCAL_MEDIA_URL + '?source='

interface MediaRange {
  offset: number
  length: number
}

function parseRange(header: string, size: number): MediaRange | undefined {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header)
  if (!match || size === 0) return undefined
  const first = match[1]
  const last = match[2]
  if (!first) {
    const tail = Number(last)
    if (!Number.isSafeInteger(tail) || tail <= 0) return undefined
    const length = Math.min(tail, size)
    return { offset: size - length, length }
  }
  const offset = Number(first)
  const end = last ? Number(last) : size - 1
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(end) || offset >= size || end < offset) {
    return undefined
  }
  return { offset, length: Math.min(end, size - 1) - offset + 1 }
}

function emptyResponse(code: number, message: string, headers: Header[] = []): WebResourceResponse {
  const response = new WebResourceResponse()
  response.setResponseData(new ArrayBuffer(0))
  response.setResponseMimeType('text/plain')
  response.setResponseHeader(headers)
  response.setResponseCode(code)
  response.setReasonMessage(message)
  return response
}

export function loadLocalMedia(
  request: WebResourceRequest,
  appId: string,
  packageRoot: string,
  mimeTypeForExtension: (extension: string) => string
): WebResourceResponse {
  const url = request.getRequestUrl()
  if (request.isMainFrame() || !url.startsWith(SOURCE_QUERY)) {
    return emptyResponse(404, 'Not Found')
  }
  try {
    let source = decodeURIComponent(url.substring(SOURCE_QUERY.length))
    if (source.startsWith('file:///')) source = source.substring('file://'.length)
    const packagePrefix = `/${appId}/`
    if (source.startsWith(packagePrefix)) source = source.substring(packagePrefix.length)
    const path = DMPFilePathResolver.resolve(source, appId, packageRoot)
    const stat = fs.statSync(path)
    if (!stat.isFile()) return emptyResponse(404, 'Not Found')

    const header = request.getRequestHeader().find((entry: Header): boolean => entry.headerKey.toLowerCase() === 'range')
    const range = header ? parseRange(header.headerValue, stat.size) : undefined
    if (header && !range) {
      return emptyResponse(416, 'Range Not Satisfiable', [{ headerKey: 'Content-Range', headerValue: `bytes */${stat.size}` }])
    }
    const response = new WebResourceResponse()
    const extension = path.substring(path.lastIndexOf('.') + 1)
    response.setResponseMimeType(mimeTypeForExtension(extension))
    const headers: Header[] = [
      { headerKey: 'Accept-Ranges', headerValue: 'bytes' },
      { headerKey: 'Content-Length', headerValue: String(range?.length ?? stat.size) }
    ]
    // ArkWeb applies the requested byte range to the descriptor and owns its lifetime.
    const file = fs.openSync(path, fs.OpenMode.READ_ONLY)
    response.setResponseData(file.fd)
    if (range) {
      response.setResponseCode(206)
      response.setReasonMessage('Partial Content')
      headers.push({
        headerKey: 'Content-Range',
        headerValue: `bytes ${range.offset}-${range.offset + range.length - 1}/${stat.size}`
      })
    } else {
      response.setResponseCode(200)
      response.setReasonMessage('OK')
    }
    response.setResponseHeader(headers)
    response.setResponseIsReady(true)
    return response
  } catch (_) {
    return emptyResponse(404, 'Not Found')
  }
}
