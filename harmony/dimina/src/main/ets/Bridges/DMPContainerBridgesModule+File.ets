import fs from '@ohos.file.fs';
import cryptoFramework from '@ohos.security.cryptoFramework';
import { util } from '@kit.ArkTS';
import { brotliDecompress } from 'libdimina.so';
import { DMPContainerBridgesModule } from './DMPContainerBridgesModule';
import { DMPBridgeCallback } from './DMPTSUtil';
import { DMPMap } from '../Utils/DMPMap';
import { DMPContextUtils } from '../Utils/DMPContextUtils';
import { DMPFileUrlConvertor } from '../Bundle/Util/DMPFileUrlConvertor';
import { DMPApp } from '../DApp/DMPApp';
import { WorkerAppData } from '../Service/DMPSendableObjects';
import { DMPUnzipManager } from '../Bundle/Util/DMPUnzipManager';

const VIRTUAL_PREFIX = 'difile://';
const USER_PREFIX = 'usr';
const TEMP_PREFIX = 'tmp';
const ARRAY_BUFFER_BASE64_KEY = '__diminaArrayBufferBase64';
const FILE_DATA_BASE64_KEY = '__diminaFileDataBase64';
const FILE_DATA_TYPE_KEY = '__diminaFileDataType';
const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

class OpenedFile {
  file: fs.File;
  path: string;

  constructor(file: fs.File, path: string) {
    this.file = file;
    this.path = path;
  }
}

class ZipEntryRequest {
  path: string;
  encoding: string;
  position: number;
  length?: number;

  constructor(path: string, encoding: string, position: number, length?: number) {
    this.path = path;
    this.encoding = encoding;
    this.position = position;
    this.length = length;
  }
}

export class DMPContainerBridgesModuleFile extends DMPContainerBridgesModule {
  private static openedFiles: Map<string, OpenedFile> = new Map();

  constructor(app: DMPApp);
  constructor(app: WorkerAppData);
  constructor(app: DMPApp | WorkerAppData) {
    super(app as DMPApp);
  }

  getExportMethods(): string[] {
    return [
      'saveFileToDisk',
      'FileSystemManager.access',
      'FileSystemManager.accessSync',
      'FileSystemManager.appendFile',
      'FileSystemManager.appendFileSync',
      'FileSystemManager.close',
      'FileSystemManager.closeSync',
      'FileSystemManager.copyFile',
      'FileSystemManager.copyFileSync',
      'FileSystemManager.fstat',
      'FileSystemManager.fstatSync',
      'FileSystemManager.ftruncate',
      'FileSystemManager.ftruncateSync',
      'FileSystemManager.getFileInfo',
      'FileSystemManager.getSavedFileList',
      'FileSystemManager.mkdir',
      'FileSystemManager.mkdirSync',
      'FileSystemManager.open',
      'FileSystemManager.openSync',
      'FileSystemManager.read',
      'FileSystemManager.readSync',
      'FileSystemManager.readCompressedFile',
      'FileSystemManager.readCompressedFileSync',
      'FileSystemManager.readdir',
      'FileSystemManager.readdirSync',
      'FileSystemManager.readFile',
      'FileSystemManager.readFileSync',
      'FileSystemManager.readZipEntry',
      'FileSystemManager.removeSavedFile',
      'FileSystemManager.rename',
      'FileSystemManager.renameSync',
      'FileSystemManager.rmdir',
      'FileSystemManager.rmdirSync',
      'FileSystemManager.saveFile',
      'FileSystemManager.saveFileSync',
      'FileSystemManager.stat',
      'FileSystemManager.statSync',
      'FileSystemManager.truncate',
      'FileSystemManager.truncateSync',
      'FileSystemManager.unlink',
      'FileSystemManager.unlinkSync',
      'FileSystemManager.unzip',
      'FileSystemManager.write',
      'FileSystemManager.writeSync',
      'FileSystemManager.writeFile',
      'FileSystemManager.writeFileSync',
    ];
  }

  dispatchFileSystemManager(methodName: string, params: DMPMap | number | string | boolean | object, callback: DMPBridgeCallback): DMPMap | number | string | boolean | object {
    const data = this.mapParam(params);
    const pathData = this.mapOrStringParam(params);
    switch (methodName) {
      case 'FileSystemManager.access':
        this.access(data, callback);
        return new DMPMap();
      case 'FileSystemManager.accessSync':
        this.accessSync(pathData);
        return new DMPMap();
      case 'FileSystemManager.appendFile':
        this.appendFile(data, callback);
        return new DMPMap();
      case 'FileSystemManager.appendFileSync':
        this.appendFileSync(data);
        return new DMPMap();
      case 'FileSystemManager.close':
        this.close(data, callback);
        return new DMPMap();
      case 'FileSystemManager.closeSync':
        this.closeSync(pathData);
        return new DMPMap();
      case 'FileSystemManager.copyFile':
        this.copyFile(data, callback);
        return new DMPMap();
      case 'FileSystemManager.copyFileSync':
        this.copyFileSync(data);
        return new DMPMap();
      case 'FileSystemManager.fstat':
        this.fstat(data, callback);
        return new DMPMap();
      case 'FileSystemManager.fstatSync':
        return this.fstatSync(data);
      case 'FileSystemManager.ftruncate':
        this.ftruncate(data, callback);
        return new DMPMap();
      case 'FileSystemManager.ftruncateSync':
        this.ftruncateSync(data);
        return new DMPMap();
      case 'FileSystemManager.getFileInfo':
        this.getFileInfo(data, callback);
        return new DMPMap();
      case 'FileSystemManager.getSavedFileList':
        this.getSavedFileList(data, callback);
        return new DMPMap();
      case 'FileSystemManager.mkdir':
        this.mkdir(data, callback);
        return new DMPMap();
      case 'FileSystemManager.mkdirSync':
        this.mkdirSync(data);
        return new DMPMap();
      case 'FileSystemManager.open':
        this.open(data, callback);
        return new DMPMap();
      case 'FileSystemManager.openSync':
        return this.openSync(data);
      case 'FileSystemManager.read':
        this.read(data, callback);
        return new DMPMap();
      case 'FileSystemManager.readSync':
        return this.readSync(data);
      case 'FileSystemManager.readCompressedFile':
        this.readCompressedFile(data, callback);
        return new DMPMap();
      case 'FileSystemManager.readCompressedFileSync':
        return this.readCompressedFileSync(data);
      case 'FileSystemManager.readdir':
        this.readdir(data, callback);
        return new DMPMap();
      case 'FileSystemManager.readdirSync':
        return this.readdirSync(pathData);
      case 'FileSystemManager.readFile':
        this.readFile(data, callback);
        return new DMPMap();
      case 'FileSystemManager.readFileSync':
        return this.readFileSync(data);
      case 'FileSystemManager.readZipEntry':
        this.readZipEntry(data, callback);
        return new DMPMap();
      case 'FileSystemManager.removeSavedFile':
        this.removeSavedFile(data, callback);
        return new DMPMap();
      case 'FileSystemManager.rename':
        this.rename(data, callback);
        return new DMPMap();
      case 'FileSystemManager.renameSync':
        this.renameSync(data);
        return new DMPMap();
      case 'FileSystemManager.rmdir':
        this.rmdir(data, callback);
        return new DMPMap();
      case 'FileSystemManager.rmdirSync':
        this.rmdirSync(data);
        return new DMPMap();
      case 'FileSystemManager.saveFile':
        this.saveFile(data, callback);
        return new DMPMap();
      case 'FileSystemManager.saveFileSync':
        return this.saveFileSync(data);
      case 'FileSystemManager.stat':
        this.stat(data, callback);
        return new DMPMap();
      case 'FileSystemManager.statSync':
        return this.statSync(data);
      case 'FileSystemManager.truncate':
        this.truncate(data, callback);
        return new DMPMap();
      case 'FileSystemManager.truncateSync':
        this.truncateSync(data);
        return new DMPMap();
      case 'FileSystemManager.unlink':
        this.unlink(data, callback);
        return new DMPMap();
      case 'FileSystemManager.unlinkSync':
        this.unlinkSync(pathData);
        return new DMPMap();
      case 'FileSystemManager.unzip':
        this.unzip(data, callback);
        return new DMPMap();
      case 'FileSystemManager.write':
        this.write(data, callback);
        return new DMPMap();
      case 'FileSystemManager.writeSync':
        return this.writeSync(data);
      case 'FileSystemManager.writeFile':
        this.writeFile(data, callback);
        return new DMPMap();
      case 'FileSystemManager.writeFileSync':
        this.writeFileSync(data);
        return new DMPMap();
      default:
        throw new Error(`Bridge not implemented ${methodName}`);
    }
  }

  saveFileToDisk(_data: DMPMap, callback: DMPBridgeCallback) {
    this.invokeFailureCallback(callback, null, 'saveFileToDisk:fail not supported on this platform');
  }

  access(data: DMPMap, callback: DMPBridgeCallback) {
    this.callAsync('FileSystemManager.access', callback, () => {
      this.ensureExists(this.pathParam(data));
      return new DMPMap();
    });
  }

  accessSync(data: DMPMap | string): void {
    this.ensureExists(this.stringParam(data, 'path'));
  }

  appendFile(data: DMPMap, callback: DMPBridgeCallback) {
    this.callAsync('FileSystemManager.appendFile', callback, () => {
      this.appendFileSync(data);
      return new DMPMap();
    });
  }

  appendFileSync(data: DMPMap): void {
    const path = this.resolve(data.getString('filePath') ?? '');
    const file = fs.openSync(path, fs.OpenMode.READ_WRITE);
    const stat = fs.statSync(path);
    const bytes = this.dataBytes(data);
    fs.writeSync(file.fd, bytes, { offset: stat.size, length: bytes.byteLength });
    fs.closeSync(file);
  }

  close(data: DMPMap, callback: DMPBridgeCallback) {
    this.callAsync('FileSystemManager.close', callback, () => {
      this.closeSync(data);
      return new DMPMap();
    });
  }

  closeSync(data: DMPMap | string): void {
    const fd = this.stringParam(data, 'fd');
    const opened = DMPContainerBridgesModuleFile.openedFiles.get(fd);
    if (!opened) {
      throw new Error('bad file descriptor');
    }
    fs.closeSync(opened.file);
    DMPContainerBridgesModuleFile.openedFiles.delete(fd);
  }

  copyFile(data: DMPMap, callback: DMPBridgeCallback) {
    this.callAsync('FileSystemManager.copyFile', callback, () => {
      this.copyFileSync(data);
      return new DMPMap();
    });
  }

  copyFileSync(data: DMPMap): void {
    fs.copyFileSync(this.resolve(data.getString('srcPath') ?? ''), this.resolve(data.getString('destPath') ?? ''));
  }

  fstat(data: DMPMap, callback: DMPBridgeCallback) {
    this.callAsync('FileSystemManager.fstat', callback, () => this.resultMap('stats', this.fstatSync(data)));
  }

  fstatSync(data: DMPMap): DMPMap {
    return this.statObject(this.opened(data).path);
  }

  ftruncate(data: DMPMap, callback: DMPBridgeCallback) {
    this.callAsync('FileSystemManager.ftruncate', callback, () => {
      this.ftruncateSync(data);
      return new DMPMap();
    });
  }

  ftruncateSync(data: DMPMap): void {
    fs.truncateSync(this.opened(data).path, data.getNumber('length') ?? 0);
  }

  getFileInfo(data: DMPMap, callback: DMPBridgeCallback) {
    const apiName = 'FileSystemManager.getFileInfo';
    try {
      const path = this.resolve(data.getString('filePath') ?? '');
      const stat = fs.statSync(path);
      const algorithm = (data.getString('digestAlgorithm') ?? 'md5').toLowerCase();
      this.digestFile(path, algorithm).then((digest: string) => {
        const result = new DMPMap();
        result.set('size', stat.size);
        result.set('digest', digest);
        result.set('errMsg', `${apiName}:ok`);
        this.invokeSuccessCallback(callback, result);
      }).catch((err: Error) => {
        this.invokeFailureCallback(callback, null, `${apiName}:fail ${err.message ?? err}`);
      });
    } catch (err) {
      this.invokeFailureCallback(callback, null, `${apiName}:fail ${(err as Error).message ?? err}`);
    }
  }

  getSavedFileList(_data: DMPMap, callback: DMPBridgeCallback) {
    this.callAsync('FileSystemManager.getSavedFileList', callback, () => this.resultMap('fileList', this.savedFiles()));
  }

  mkdir(data: DMPMap, callback: DMPBridgeCallback) {
    this.callAsync('FileSystemManager.mkdir', callback, () => {
      this.mkdirSync(data);
      return new DMPMap();
    });
  }

  mkdirSync(data: DMPMap): void {
    fs.mkdirSync(this.resolve(data.getString('dirPath') ?? ''), data.getBoolean('recursive') ?? false);
  }

  open(data: DMPMap, callback: DMPBridgeCallback) {
    this.callAsync('FileSystemManager.open', callback, () => this.resultMap('fd', this.openSync(data)));
  }

  openSync(data: DMPMap): string {
    const path = this.resolve(data.getString('filePath') ?? '');
    const flag = data.getString('flag') ?? 'r';
    let mode = fs.OpenMode.READ_ONLY;
    if (flag !== 'r') {
      mode = fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE;
    }
    const file = fs.openSync(path, mode);
    if (flag === 'w' || flag === 'w+') {
      fs.truncateSync(path, 0);
    }
    const fd = `${Date.now()}_${Math.random()}`;
    DMPContainerBridgesModuleFile.openedFiles.set(fd, new OpenedFile(file, path));
    return fd;
  }

  read(data: DMPMap, callback: DMPBridgeCallback) {
    this.callAsync('FileSystemManager.read', callback, () => this.readSync(data));
  }

  readSync(data: DMPMap): DMPMap {
    const opened = this.opened(data);
    const stat = fs.statSync(opened.path);
    const length = data.getNumber('length') ?? data.getNumber('arrayBufferLength') ?? stat.size;
    const position = data.getNumber('position') ?? 0;
    const buffer = new ArrayBuffer(length);
    const bytesRead = fs.readSync(opened.file.fd, buffer, { offset: position, length });
    const result = this.arrayBufferPayload(buffer, bytesRead);
    result.set('bytesRead', bytesRead);
    return result;
  }

  readCompressedFile(data: DMPMap, callback: DMPBridgeCallback) {
    this.callAsync('FileSystemManager.readCompressedFile', callback, () => this.resultMap('data', this.readCompressedFileSync(data)));
  }

  readCompressedFileSync(data: DMPMap): DMPMap {
    const algorithm = (data.getString('compressionAlgorithm') ?? '').toLowerCase();
    if (algorithm !== 'br') {
      throw new Error(`unsupported compressionAlgorithm ${algorithm}`);
    }
    const bytes: ArrayBuffer = brotliDecompress(this.readFileBytes(this.resolve(data.getString('filePath') ?? '')));
    return this.arrayBufferPayload(bytes, bytes.byteLength);
  }

  readdir(data: DMPMap, callback: DMPBridgeCallback) {
    this.callAsync('FileSystemManager.readdir', callback, () => this.resultMap('files', this.readdirSync(data)));
  }

  readdirSync(data: DMPMap | string): string[] {
    return fs.listFileSync(this.resolve(this.stringParam(data, 'dirPath')));
  }

  readFile(data: DMPMap, callback: DMPBridgeCallback) {
    this.callAsync('FileSystemManager.readFile', callback, () => this.resultMap('data', this.readFileSync(data)));
  }

  readFileSync(data: DMPMap): string | DMPMap {
    const path = this.resolve(data.getString('filePath') ?? '');
    const stat = fs.statSync(path);
    const position = data.getNumber('position') ?? 0;
    const length = data.getNumber('length') ?? stat.size - position;
    const bytes = this.sliceArrayBuffer(this.readFileBytes(path), position, length);
    if (data.getString('encoding')) {
      return this.decodeBytes(bytes, data.getString('encoding') ?? '');
    }
    return this.arrayBufferPayload(bytes, bytes.byteLength);
  }

  readZipEntry(data: DMPMap, callback: DMPBridgeCallback) {
    const apiName = 'FileSystemManager.readZipEntry';
    let targetPath = '';
    try {
      const zipPath = this.resolve(data.getString('filePath') ?? '');
      targetPath = `${this.tempRoot()}/zip-entry-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
      fs.mkdirSync(targetPath, true);
      DMPUnzipManager.unzipFileAtPath(zipPath, targetPath, (_path, succeeded, error) => {
        if (!succeeded) {
          this.invokeFailureCallback(callback, null, `${apiName}:fail ${error?.message ?? ''}`);
          return;
        }

        try {
          const result = this.resultMap('entries', this.readZipEntries(data, targetPath));
          result.set('errMsg', `${apiName}:ok`);
          this.invokeSuccessCallback(callback, result);
        } catch (err) {
          this.invokeFailureCallback(callback, null, `${apiName}:fail ${(err as Error).message ?? err}`);
        } finally {
          this.deleteRecursive(targetPath);
        }
      });
    } catch (err) {
      if (targetPath) {
        this.deleteRecursive(targetPath);
      }
      this.invokeFailureCallback(callback, null, `${apiName}:fail ${(err as Error).message ?? err}`);
    }
  }

  removeSavedFile(data: DMPMap, callback: DMPBridgeCallback) {
    this.unlink(data, callback);
  }

  rename(data: DMPMap, callback: DMPBridgeCallback) {
    this.callAsync('FileSystemManager.rename', callback, () => {
      this.renameSync(data);
      return new DMPMap();
    });
  }

  renameSync(data: DMPMap): void {
    fs.moveFileSync(this.resolve(data.getString('oldPath') ?? ''), this.resolve(data.getString('newPath') ?? ''), 0);
  }

  rmdir(data: DMPMap, callback: DMPBridgeCallback) {
    this.callAsync('FileSystemManager.rmdir', callback, () => {
      this.rmdirSync(data);
      return new DMPMap();
    });
  }

  rmdirSync(data: DMPMap): void {
    const path = this.resolve(data.getString('dirPath') ?? '');
    if (data.getBoolean('recursive')) {
      this.deleteRecursive(path);
    } else {
      fs.rmdirSync(path);
    }
  }

  saveFile(data: DMPMap, callback: DMPBridgeCallback) {
    this.callAsync('FileSystemManager.saveFile', callback, () => this.resultMap('savedFilePath', this.saveFileSync(data)));
  }

  saveFileSync(data: DMPMap): string {
    const temp = this.resolve(data.getString('tempFilePath') ?? '');
    if (!fs.accessSync(temp)) {
      throw new Error(`no such file or directory ${data.getString('tempFilePath') ?? ''}`);
    }
    const targetPath = data.getString('filePath') ?? `${VIRTUAL_PREFIX}${USER_PREFIX}/saved/${Date.now()}_${this.nameFromPath(temp)}`;
    const dest = this.resolve(targetPath);
    if (!data.getString('filePath')) {
      this.ensureParentDirectory(dest);
    }
    fs.moveFileSync(temp, dest, 0);
    return this.userPath(dest);
  }

  stat(data: DMPMap, callback: DMPBridgeCallback) {
    this.callAsync('FileSystemManager.stat', callback, () => this.resultMap('stats', this.statSync(data)));
  }

  statSync(data: DMPMap): DMPMap {
    const path = this.resolve(data.getString('path') ?? data.getString('args') ?? '');
    return this.statObject(path);
  }

  truncate(data: DMPMap, callback: DMPBridgeCallback) {
    this.callAsync('FileSystemManager.truncate', callback, () => {
      this.truncateSync(data);
      return new DMPMap();
    });
  }

  truncateSync(data: DMPMap): void {
    fs.truncateSync(this.resolve(data.getString('filePath') ?? ''), data.getNumber('length') ?? 0);
  }

  unlink(data: DMPMap, callback: DMPBridgeCallback) {
    this.callAsync('FileSystemManager.unlink', callback, () => {
      this.unlinkSync(data);
      return new DMPMap();
    });
  }

  unlinkSync(data: DMPMap | string): void {
    fs.unlinkSync(this.resolve(this.stringParam(data, 'filePath')));
  }

  unzip(data: DMPMap, callback: DMPBridgeCallback) {
    const zipPath = this.resolve(data.getString('zipFilePath') ?? '');
    const targetPath = this.resolve(data.getString('targetPath') ?? '');
    DMPUnzipManager.unzipFileAtPath(zipPath, targetPath, (_path, succeeded, error) => {
      if (succeeded) {
        const result = new DMPMap();
        result.set('errMsg', 'FileSystemManager.unzip:ok');
        this.invokeSuccessCallback(callback, result);
      } else {
        this.invokeFailureCallback(callback, null, `FileSystemManager.unzip:fail ${error?.message ?? ''}`);
      }
    });
  }

  write(data: DMPMap, callback: DMPBridgeCallback) {
    this.callAsync('FileSystemManager.write', callback, () => this.writeSync(data));
  }

  writeSync(data: DMPMap): DMPMap {
    const opened = this.opened(data);
    const dataKey = data.get('arrayBuffer') ? 'arrayBuffer' : 'data';
    const allBytes = this.dataBytes(data, dataKey);
    const bytes = this.sliceArrayBuffer(allBytes, data.getNumber('offset') ?? 0, data.getNumber('length'));
    fs.writeSync(opened.file.fd, bytes, { offset: data.getNumber('position') ?? undefined, length: bytes.byteLength });
    return this.resultMap('bytesWritten', bytes.byteLength);
  }

  writeFile(data: DMPMap, callback: DMPBridgeCallback) {
    this.callAsync('FileSystemManager.writeFile', callback, () => {
      this.writeFileSync(data);
      return new DMPMap();
    });
  }

  writeFileSync(data: DMPMap): void {
    const path = this.resolve(data.getString('filePath') ?? '');
    const file = fs.openSync(path, fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE);
    const bytes = this.dataBytes(data);
    fs.truncateSync(path, 0);
    fs.writeSync(file.fd, bytes, { length: bytes.byteLength });
    fs.closeSync(file);
  }

  private callAsync(name: string, callback: DMPBridgeCallback, block: () => DMPMap): void {
    try {
      const result = block();
      result.set('errMsg', `${name}:ok`);
      this.invokeSuccessCallback(callback, result);
    } catch (err) {
      this.invokeFailureCallback(callback, null, `${name}:fail ${(err as Error).message ?? err}`);
    }
  }

  private mapParam(params: DMPMap | number | string | boolean | object): DMPMap {
    if (params instanceof DMPMap) {
      return params;
    }
    if (typeof params === 'object') {
      return DMPMap.createFromObject(params as Object);
    }
    return new DMPMap();
  }

  private mapOrStringParam(params: DMPMap | number | string | boolean | object): DMPMap | string {
    if (typeof params === 'string') {
      return params;
    }
    return this.mapParam(params);
  }

  private resultMap(key: string, value: Object | string | number | boolean): DMPMap {
    const result = new DMPMap();
    result.set(key, value);
    return result;
  }

  private arrayBufferPayload(buffer: ArrayBuffer, length: number): DMPMap {
    const result = new DMPMap();
    result.set(ARRAY_BUFFER_BASE64_KEY, this.arrayBufferToBase64(buffer, length));
    return result;
  }

  private userRoot(): string {
    const context = DMPContextUtils.getUIAbilityContext();
    const path = `${context.filesDir}/dimina-file-system/${this.currentAppId()}/${USER_PREFIX}`;
    this.ensureDirectory(path);
    return path;
  }

  private currentAppId(): string {
    return this.appData.appId || this.app?.appConfig?.appId || 'default';
  }

  private tempRoot(): string {
    const context = DMPContextUtils.getUIAbilityContext();
    this.ensureDirectory(context.cacheDir);
    return context.cacheDir;
  }

  private ensureDirectory(path: string): void {
    if (!fs.accessSync(path)) {
      fs.mkdirSync(path, true);
    }
  }

  private ensureParentDirectory(path: string): void {
    const index = path.lastIndexOf('/');
    if (index > 0) {
      this.ensureDirectory(path.substring(0, index));
    }
  }

  private resolve(rawPath: string): string {
    if (!rawPath) {
      throw new Error('missing file path');
    }
    const userRoot = this.userRoot();
    const tempRoot = this.tempRoot();
    let path = rawPath;
    if (rawPath.startsWith(VIRTUAL_PREFIX)) {
      const relative = rawPath.replace(VIRTUAL_PREFIX, '').replace(/^\/+/, '');
      if (relative === USER_PREFIX || relative.startsWith(`${USER_PREFIX}/`)) {
        path = `${userRoot}/${relative.replace(USER_PREFIX, '').replace(/^\/+/, '')}`;
      } else if (relative === TEMP_PREFIX || relative.startsWith(`${TEMP_PREFIX}/`)) {
        path = `${tempRoot}/${relative.replace(TEMP_PREFIX, '').replace(/^\/+/, '')}`;
      } else {
        path = DMPFileUrlConvertor.localPathFromVPath(rawPath);
      }
    }
    if (!path.startsWith(userRoot) && !path.startsWith(tempRoot)) {
      throw new Error(`permission denied, open ${rawPath}`);
    }
    return path;
  }

  private stringParam(data: DMPMap | string, key: string): string {
    if (typeof data === 'string') {
      return data;
    }
    return data.getString(key) ?? data.getString('path') ?? data.getString('filePath') ?? data.getString('dirPath') ?? data.getString('args') ?? '';
  }

  private pathParam(data: DMPMap): string {
    return this.stringParam(data, 'path');
  }

  private ensureExists(path: string): void {
    if (!fs.accessSync(this.resolve(path))) {
      throw new Error(`no such file or directory ${path}`);
    }
  }

  private opened(data: DMPMap): OpenedFile {
    const fd = data.getString('fd') ?? '';
    const opened = DMPContainerBridgesModuleFile.openedFiles.get(fd);
    if (!opened) {
      throw new Error('bad file descriptor');
    }
    return opened;
  }

  private statObject(path: string): DMPMap {
    const stat = fs.statSync(path);
    const isDirectory = stat.isDirectory();
    const result = new DMPMap();
    result.set('mode', isDirectory ? 'directory' : 'file');
    result.set('size', isDirectory ? 0 : stat.size);
    result.set('lastAccessedTime', Math.floor(stat.atime / 1000));
    result.set('lastModifiedTime', Math.floor(stat.mtime / 1000));
    result.set('isDirectory', isDirectory);
    result.set('isFile', stat.isFile());
    return result;
  }

  private dataBytes(data: DMPMap, key: string = 'data'): ArrayBuffer {
    const value: Object | string | number | boolean | undefined = data.get(key);
    if (value instanceof Object) {
      const encoded = DMPMap.createFromObject(value as Object);
      if (encoded.getString(FILE_DATA_TYPE_KEY) === 'base64') {
        return this.base64ToArrayBuffer(encoded.getString(FILE_DATA_BASE64_KEY) ?? '');
      }
    }
    return this.stringToArrayBuffer(String(value ?? ''));
  }

  private readFileBytes(path: string): ArrayBuffer {
    const stat = fs.statSync(path);
    const file = fs.openSync(path, fs.OpenMode.READ_ONLY);
    const buffer = new ArrayBuffer(stat.size);
    fs.readSync(file.fd, buffer, { length: stat.size });
    fs.closeSync(file);
    return buffer;
  }

  private async digestFile(path: string, algorithm: string): Promise<string> {
    const buffer = this.readFileBytes(path);
    const md = cryptoFramework.createMd(algorithm === 'sha1' ? 'SHA1' : 'MD5');
    await md.update({ data: new Uint8Array(buffer) });
    const result = await md.digest();
    return this.bytesToHex(result.data);
  }

  private readZipEntries(data: DMPMap, rootPath: string): DMPMap {
    const entries = new DMPMap();
    const requests = this.zipEntryRequests(data, rootPath);
    requests.forEach((request: ZipEntryRequest) => {
      const item = new DMPMap();
      const entryPath = `${rootPath}/${request.path}`;
      if (request.path.includes('..') || request.path.startsWith('/') || !fs.accessSync(entryPath) || fs.statSync(entryPath).isDirectory()) {
        item.set('errMsg', `FileSystemManager.readZipEntry:fail no such entry ${request.path}`);
      } else {
        const bytes = this.sliceArrayBuffer(this.readFileBytes(entryPath), request.position, request.length);
        item.set('data', request.encoding ? this.decodeBytes(bytes, request.encoding) : this.arrayBufferPayload(bytes, bytes.byteLength));
        item.set('errMsg', 'FileSystemManager.readZipEntry:ok');
      }
      entries.set(request.path, item);
    });
    return entries;
  }

  private zipEntryRequests(data: DMPMap, rootPath: string): ZipEntryRequest[] {
    const rawEntries = data.getArray<Object | string>('entries');
    if (rawEntries) {
      return rawEntries.map((item: Object | string): ZipEntryRequest => {
        if (typeof item === 'string') {
          return new ZipEntryRequest(item, '', 0);
        }
        const map = DMPMap.createFromObject(item);
        return new ZipEntryRequest(
          map.getString('path') ?? '',
          map.getString('encoding') ?? '',
          map.getNumber('position') ?? 0,
          map.getNumber('length')
        );
      }).filter((item: ZipEntryRequest): boolean => item.path.length > 0);
    }

    const encoding = data.getString('encoding') ?? '';
    return this.listFilesRecursive(rootPath)
      .map((path: string): ZipEntryRequest => new ZipEntryRequest(path.replace(rootPath, '').replace(/^\/+/, ''), encoding, 0));
  }

  private listFilesRecursive(path: string): string[] {
    const files: string[] = [];
    if (!fs.accessSync(path)) {
      return files;
    }
    fs.listFileSync(path).forEach((name: string) => {
      const child = `${path}/${name}`;
      if (fs.statSync(child).isDirectory()) {
        files.push(...this.listFilesRecursive(child));
      } else {
        files.push(child);
      }
    });
    return files;
  }

  private deleteRecursive(path: string): void {
    if (!fs.accessSync(path)) {
      return;
    }
    if (fs.statSync(path).isDirectory()) {
      fs.listFileSync(path).forEach((name: string) => this.deleteRecursive(`${path}/${name}`));
      fs.rmdirSync(path);
    } else {
      fs.unlinkSync(path);
    }
  }

  private savedFiles(): DMPMap[] {
    const savedPath = `${this.userRoot()}/saved`;
    if (!fs.accessSync(savedPath)) {
      return [];
    }
    return fs.listFileSync(savedPath).map((name: string): DMPMap => {
      const path = `${savedPath}/${name}`;
      const stat = fs.statSync(path);
      const item = new DMPMap();
      item.set('filePath', this.userPath(path));
      item.set('size', stat.size);
      item.set('createTime', Math.floor(stat.mtime / 1000));
      return item;
    });
  }

  private userPath(path: string): string {
    return `${VIRTUAL_PREFIX}${USER_PREFIX}/${path.replace(this.userRoot(), '').replace(/^\/+/, '')}`;
  }

  private nameFromPath(path: string): string {
    const parts = path.split('/');
    return parts[parts.length - 1] || 'file';
  }

  private stringToArrayBuffer(text: string): ArrayBuffer {
    return new util.TextEncoder().encodeInto(text).buffer;
  }

  private arrayBufferToBase64(buffer: ArrayBuffer, length: number): string {
    const bytes = new Uint8Array(buffer);
    let result = '';
    let i = 0;
    const count = Math.min(length, bytes.length);
    for (; i + 2 < count; i += 3) {
      result += BASE64_CHARS.charAt(bytes[i] >> 2);
      result += BASE64_CHARS.charAt(((bytes[i] & 3) << 4) | (bytes[i + 1] >> 4));
      result += BASE64_CHARS.charAt(((bytes[i + 1] & 15) << 2) | (bytes[i + 2] >> 6));
      result += BASE64_CHARS.charAt(bytes[i + 2] & 63);
    }
    if (i < count) {
      result += BASE64_CHARS.charAt(bytes[i] >> 2);
      if (i + 1 < count) {
        result += BASE64_CHARS.charAt(((bytes[i] & 3) << 4) | (bytes[i + 1] >> 4));
        result += BASE64_CHARS.charAt((bytes[i + 1] & 15) << 2);
        result += '=';
      } else {
        result += BASE64_CHARS.charAt((bytes[i] & 3) << 4);
        result += '==';
      }
    }
    return result;
  }

  private sliceArrayBuffer(buffer: ArrayBuffer, position: number = 0, length?: number): ArrayBuffer {
    const start = Math.min(Math.max(position, 0), buffer.byteLength);
    const end = length === undefined ? buffer.byteLength : Math.min(start + Math.max(length, 0), buffer.byteLength);
    return buffer.slice(start, end);
  }

  private decodeBytes(buffer: ArrayBuffer, encoding: string): string {
    if (encoding.toLowerCase() === 'base64') {
      return this.arrayBufferToBase64(buffer, buffer.byteLength);
    }
    if (encoding.toLowerCase() === 'hex') {
      return this.bytesToHex(new Uint8Array(buffer));
    }
    const decoder = util.TextDecoder.create('utf-8');
    return decoder.decodeToString(new Uint8Array(buffer));
  }

  private bytesToHex(bytes: Uint8Array): string {
    let result = '';
    for (let i = 0; i < bytes.length; i++) {
      result += bytes[i].toString(16).padStart(2, '0');
    }
    return result;
  }

  private base64ToArrayBuffer(base64: string): ArrayBuffer {
    const clean = (base64 ?? '').replace(/[\r\n\s]/g, '');
    const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
    const length = clean.length * 3 / 4 - padding;
    const buffer = new ArrayBuffer(length);
    const out = new Uint8Array(buffer);
    let index = 0;
    for (let i = 0; i < clean.length; i += 4) {
      const c1 = BASE64_CHARS.indexOf(clean[i]);
      const c2 = BASE64_CHARS.indexOf(clean[i + 1]);
      const c3 = clean[i + 2] === '=' ? 0 : BASE64_CHARS.indexOf(clean[i + 2]);
      const c4 = clean[i + 3] === '=' ? 0 : BASE64_CHARS.indexOf(clean[i + 3]);
      if (index < length) out[index++] = (c1 << 2) | (c2 >> 4);
      if (index < length) out[index++] = ((c2 & 15) << 4) | (c3 >> 2);
      if (index < length) out[index++] = ((c3 & 3) << 6) | c4;
    }
    return buffer;
  }
}
