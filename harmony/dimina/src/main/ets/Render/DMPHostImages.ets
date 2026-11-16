import fs from '@ohos.file.fs';
import resourceManager from '@ohos.resourceManager';

class HostImage {
  resource?: Resource;
  manager?: resourceManager.ResourceManager;
  path: string = '';
  directory: boolean = false;
  mimeType: string = '';
}

/** Explicit host registry; images are read from rawfile or host files without sandbox copies. */
export class DMPHostImages {
  private static images: Map<string, HostImage> = new Map();

  static registerRawFile(id: string, resource: Resource, format: string = 'png'): void {
    DMPHostImages.validateId(id);
    const entry = new HostImage();
    entry.resource = resource;
    entry.mimeType = DMPHostImages.mimeType(format);
    DMPHostImages.images.set(id, entry);
  }

  static registerRawDirectory(id: string, manager: resourceManager.ResourceManager, directory: string): void {
    DMPHostImages.validateId(id);
    const path = directory.replace(/\/+$/, '');
    DMPHostImages.validateRelativePath(path);
    if (!manager.isRawDir(path)) throw new Error('Image rawfile directory does not exist');
    const entry = new HostImage();
    entry.manager = manager;
    entry.path = path;
    entry.directory = true;
    DMPHostImages.images.set(id, entry);
  }

  static registerFile(id: string, filePath: string): void {
    DMPHostImages.validateId(id);
    if (!fs.statSync(filePath).isFile()) throw new Error('Image file is not readable');
    const entry = new HostImage();
    entry.path = filePath;
    entry.mimeType = DMPHostImages.mimeType(filePath.substring(filePath.lastIndexOf('.') + 1));
    DMPHostImages.images.set(id, entry);
  }

  static registerDirectory(id: string, directory: string): void {
    DMPHostImages.validateId(id);
    const path = directory.replace(/\/+$/, '');
    if (!path.startsWith('/')) throw new Error('Image directory must be absolute');
    DMPHostImages.validateRelativePath(path.substring(1));
    if (!fs.statSync(path).isDirectory() || fs.lstatSync(path).isSymbolicLink()) {
      throw new Error('Image directory is not readable or is a symbolic link');
    }
    const entry = new HostImage();
    entry.path = path;
    entry.directory = true;
    DMPHostImages.images.set(id, entry);
  }

  static unregister(id: string): void { DMPHostImages.images.delete(id); }

  static intercept(url: string): WebResourceResponse | null {
    const match = /^(?:http:\/\/127\.0\.0\.1|file:\/\/)\/__dimina_host_images\/([^?#]*)(?:[?#].*)?$/.exec(url);
    if (!match) return null;
    const response = new WebResourceResponse();
    response.setResponseIsReady(false);
    try {
      if (/%(?:2f|5c)/i.test(match[1])) throw new Error('Encoded path separator');
      const key = decodeURIComponent(match[1]);
      DMPHostImages.validateRelativePath(key);
      const parts = key.split('/');
      DMPHostImages.validateId(parts[0]);
      const entry = DMPHostImages.images.get(parts[0]);
      if (!entry) throw new Error('Host image is not registered');
      if (entry.directory) {
        if (parts.length < 2) throw new Error('Missing image path');
        const relative = parts.slice(1).join('/');
        response.setResponseMimeType(DMPHostImages.mimeType(relative.substring(relative.lastIndexOf('.') + 1)));
        const path = `${entry.path}/${relative}`;
        if (entry.manager) {
          DMPHostImages.readRawFile(entry.manager, path, response);
        } else {
          // Reject links at every component; a mapped directory never grants access outside its tree.
          let current = entry.path;
          if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Symbolic link');
          parts.slice(1).forEach((part: string) => {
            current += `/${part}`;
            if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Symbolic link');
          });
          if (!fs.statSync(path).isFile()) throw new Error('Image file does not exist');
          DMPHostImages.readFile(path, response);
        }
        return response;
      }
      if (parts.length !== 1) throw new Error('Image is not a directory');
      response.setResponseMimeType(entry.mimeType);
      if (entry.resource) {
        response.setResponseData(entry.resource);
        DMPHostImages.finish(response);
      } else {
        DMPHostImages.readFile(entry.path, response);
      }
    } catch (_) { DMPHostImages.fail(response); }
    return response;
  }

  private static async readRawFile(manager: resourceManager.ResourceManager, path: string,
    response: WebResourceResponse): Promise<void> {
    try {
      const bytes = await manager.getRawFileContent(path);
      response.setResponseData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      DMPHostImages.finish(response);
    } catch (_) { DMPHostImages.fail(response); }
  }

  private static async readFile(path: string, response: WebResourceResponse): Promise<void> {
    try {
      const file = await fs.open(path, fs.OpenMode.READ_ONLY);
      try {
        const stat = await fs.stat(file.fd);
        if (!stat.isFile()) throw new Error('Not an image file');
        const buffer = new ArrayBuffer(stat.size);
        const chunk = new ArrayBuffer(Math.min(65536, buffer.byteLength));
        let offset = 0;
        while (offset < buffer.byteLength) {
          const read = await fs.read(file.fd, chunk, { length: Math.min(chunk.byteLength, buffer.byteLength - offset) });
          if (read <= 0) throw new Error('Incomplete image file');
          new Uint8Array(buffer).set(new Uint8Array(chunk, 0, read), offset);
          offset += read;
        }
        response.setResponseData(buffer);
      } finally { await fs.close(file); }
      DMPHostImages.finish(response);
    } catch (_) { DMPHostImages.fail(response); }
  }

  private static finish(response: WebResourceResponse): void {
    response.setResponseCode(200);
    response.setReasonMessage('OK');
    response.setResponseIsReady(true);
  }

  private static fail(response: WebResourceResponse): void {
    response.setResponseData(new ArrayBuffer(0));
    response.setResponseCode(404);
    response.setReasonMessage('Image Not Found');
    response.setResponseIsReady(true);
  }

  private static validateId(id: string): void {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('Invalid host image ID');
  }

  private static validateRelativePath(path: string): void {
    if (path.split('/').some((part: string) => !part || part === '.' || part === '..' ||
      /[\\%?#\u0000-\u001F\u007F]/.test(part))) throw new Error('Invalid host image path');
  }

  private static mimeType(format: string): string {
    switch (format.toLowerCase()) {
      case 'png': return 'image/png';
      case 'jpg':
      case 'jpeg': return 'image/jpeg';
      case 'webp': return 'image/webp';
      case 'svg': return 'image/svg+xml';
      case 'gif': return 'image/gif';
      case 'bmp': return 'image/bmp';
      case 'ico': return 'image/x-icon';
      case 'avif': return 'image/avif';
      default: throw new Error('Unsupported host image format');
    }
  }
}
