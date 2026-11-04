import fs from '@ohos.file.fs';

class HostFont {
  resource?: Resource;
  filePath?: string;
  mimeType: string = '';
}

/** Register before opening mini programs; registration alone does not activate a font. */
export class DMPHostFonts {
  private static fonts: Map<string, HostFont> = new Map();

  static registerRawFile(id: string, resource: Resource, format: string = 'ttf'): void {
    DMPHostFonts.validateId(id);
    const font = new HostFont();
    font.resource = resource;
    font.mimeType = DMPHostFonts.mimeType(format);
    DMPHostFonts.fonts.set(id, font);
  }

  static registerFile(id: string, filePath: string): void {
    DMPHostFonts.validateId(id);
    const font = new HostFont();
    font.filePath = filePath;
    font.mimeType = DMPHostFonts.mimeType(filePath.substring(filePath.lastIndexOf('.') + 1));
    if (!fs.statSync(filePath).isFile()) throw new Error('Font file is not readable');
    DMPHostFonts.fonts.set(id, font);
  }

  static unregister(id: string): void { DMPHostFonts.fonts.delete(id); }

  private static validateId(id: string): void {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('Invalid host font ID');
  }

  private static mimeType(format: string): string {
    const extension = format.toLowerCase();
    if (!['ttf', 'otf', 'woff', 'woff2'].includes(extension)) throw new Error('Unsupported font format');
    return `font/${extension}`;
  }

  // Only a reserved URL on the render origin can read this explicit host registry.
  static intercept(url: string): WebResourceResponse | null {
    const match = /^(?:http:\/\/127\.0\.0\.1|file:\/\/)\/__dimina_host_fonts\/([^?#]*)(?:[?#].*)?$/.exec(url);
    if (!match) return null;
    const response = new WebResourceResponse();
    response.setResponseIsReady(false);
    const font = DMPHostFonts.fonts.get(match[1]);
    try {
      if (!font) throw new Error('Host font is not registered');
      if (font.resource) {
        response.setResponseData(font.resource);
      } else if (font.filePath) {
        response.setResponseMimeType(font.mimeType);
        DMPHostFonts.readFile(font.filePath, response);
        return response;
      }
      response.setResponseMimeType(font.mimeType);
      response.setResponseCode(200);
      response.setReasonMessage('OK');
    } catch (_) {
      response.setResponseData(new ArrayBuffer(0));
      response.setResponseCode(404);
      response.setReasonMessage('Font Not Found');
    }
    response.setResponseIsReady(true);
    return response;
  }

  private static async readFile(path: string, response: WebResourceResponse): Promise<void> {
    try {
      const file = await fs.open(path, fs.OpenMode.READ_ONLY);
      try {
        const buffer = new ArrayBuffer((await fs.stat(file.fd)).size);
        const chunk = new ArrayBuffer(Math.min(65536, buffer.byteLength));
        let offset = 0;
        while (offset < buffer.byteLength) {
          const read = await fs.read(file.fd, chunk, { length: Math.min(chunk.byteLength, buffer.byteLength - offset) });
          if (read <= 0) throw new Error('Incomplete font file');
          new Uint8Array(buffer).set(new Uint8Array(chunk, 0, read), offset);
          offset += read;
        }
        response.setResponseData(buffer);
        response.setResponseCode(200);
        response.setReasonMessage('OK');
      } finally { await fs.close(file); }
    } catch (_) {
      response.setResponseData(new ArrayBuffer(0));
      response.setResponseCode(404);
      response.setReasonMessage('Font Not Found');
    }
    response.setResponseIsReady(true);
  }
}
