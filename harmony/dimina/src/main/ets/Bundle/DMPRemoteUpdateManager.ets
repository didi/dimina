import fs from '@ohos.file.fs';
import cryptoFramework from '@ohos.security.cryptoFramework';
import { http } from '@kit.NetworkKit';
import { BusinessError, request } from '@kit.BasicServicesKit';
import { DMPApp } from '../DApp/DMPApp';
import { DMPFileManager } from './Util/DMPFileManager';
import { DMPUnzipManager } from './Util/DMPUnzipManager';
import { DMPContextUtils } from '../Utils/DMPContextUtils';
import { DMPLogger } from '../EventTrack/DMPLogger';
import { Tags } from '../EventTrack/Tags';

interface DMPRemoteUpdateManifest {
  appId: string;
  name: string;
  path: string;
  versionCode: number;
  versionName: string;
  packageUrl: string;
  sha256?: string;
}

interface DMPRemoteManifestPayload {
  data?: DMPRemoteManifestPayload;
  appId?: string;
  name?: string;
  path?: string;
  versionCode?: number | string;
  versionName?: string;
  packageUrl?: string;
  downloadUrl?: string;
  url?: string;
  sha256?: string;
}

interface DMPRemoteManifestConfig {
  appId: string;
  name: string;
  path: string;
  versionCode: number;
  versionName: string;
}

export class DMPRemoteUpdateManager {
  private static instance: DMPRemoteUpdateManager;
  private fileManager: DMPFileManager = DMPFileManager.sharedInstance();

  public static sharedInstance(): DMPRemoteUpdateManager {
    if (!DMPRemoteUpdateManager.instance) {
      DMPRemoteUpdateManager.instance = new DMPRemoteUpdateManager();
    }
    return DMPRemoteUpdateManager.instance;
  }

  async checkForUpdate(app: DMPApp): Promise<void> {
    const manifestUrl = app.appConfig.updateManifestUrl?.trim() ?? '';
    if (!manifestUrl) {
      app.notifyUpdateManagerStatus('noupdate');
      return;
    }

    let updateAnnounced = false;
    try {
      const manifest = await this.fetchManifest(manifestUrl);
      if (manifest.appId !== app.appConfig.appId) {
        throw new Error(`manifest appId ${manifest.appId} does not match ${app.appConfig.appId}`);
      }

      const currentVersion = app.bundleManager.getBundleInfo().currentJsAppBundleConfig?.versionCode ?? 0;
      if (manifest.versionCode <= currentVersion) {
        app.notifyUpdateManagerStatus('noupdate');
        return;
      }

      updateAnnounced = true;
      app.notifyUpdateManagerStatus('updating');

      const zipPath = await this.downloadPackage(manifest);
      if (manifest.sha256) {
        await this.verifySha256(zipPath, manifest.sha256);
      }

      await this.installPackage(manifest, zipPath);
      app.notifyUpdateManagerStatus('updateready');
    } catch (e) {
      DMPLogger.e(Tags.LOAD_REMOTE_BUNDLE, `远程更新失败: ${e}`);
      app.notifyUpdateManagerStatus(updateAnnounced ? 'updatefail' : 'noupdate');
    }
  }

  private async fetchManifest(manifestUrl: string): Promise<DMPRemoteUpdateManifest> {
    const httpRequest = http.createHttp();
    const response = await httpRequest.request(manifestUrl, {
      method: http.RequestMethod.GET,
      expectDataType: http.HttpDataType.STRING,
      usingCache: false
    });
    const statusCode = response.responseCode ?? 200;
    if (statusCode < 200 || statusCode >= 300) {
      throw new Error(`manifest request failed: HTTP ${statusCode}`);
    }

    const raw = response.result as string;
    const json = JSON.parse(raw) as DMPRemoteManifestPayload;
    const data = json.data ?? json;
    return this.parseManifest(data);
  }

  private parseManifest(data: DMPRemoteManifestPayload): DMPRemoteUpdateManifest {
    const packageUrl = data.packageUrl
      ?? data.downloadUrl
      ?? data.url
      ?? '';

    if (!data.appId) {
      throw new Error('manifest missing appId');
    }
    if (!data.path) {
      throw new Error('manifest missing path');
    }
    if (data.versionCode === undefined) {
      throw new Error('manifest missing versionCode');
    }
    if (!packageUrl) {
      throw new Error('manifest missing packageUrl');
    }

    return {
      appId: data.appId,
      name: data.name ?? '',
      path: data.path,
      versionCode: Number(data.versionCode),
      versionName: data.versionName ?? '',
      packageUrl,
      sha256: data.sha256,
    };
  }

  private async downloadPackage(manifest: DMPRemoteUpdateManifest): Promise<string> {
    const context = DMPContextUtils.getUIAbilityContext();
    const updateDir = `${context.cacheDir}/dimina-updates`;
    if (!fs.accessSync(updateDir)) {
      fs.mkdirSync(updateDir, true);
    }

    const localPath = `${updateDir}/${manifest.appId}-${manifest.versionCode}.zip`;
    if (fs.accessSync(localPath)) {
      fs.unlinkSync(localPath);
    }

    return new Promise<string>((resolve, reject) => {
      request.downloadFile(context, {
        url: manifest.packageUrl,
        filePath: localPath
      }).then((downloadTask) => {
        downloadTask.on('complete', () => {
          if (fs.accessSync(localPath)) {
            resolve(localPath);
          } else {
            reject(new Error('package download failed'));
          }
        });
      }).catch((err: BusinessError) => {
        reject(new Error(`package download failed: ${err.message}`));
      });
    });
  }

  private async installPackage(manifest: DMPRemoteUpdateManifest, zipPath: string): Promise<void> {
    const versionDir = this.fileManager.getJSAppVersionDir(manifest.appId, manifest.versionCode.toString());
    try {
      if (fs.accessSync(versionDir)) {
        fs.rmdirSync(versionDir);
      }
      fs.mkdirSync(versionDir, true);

      const unzipResult = await DMPUnzipManager.unzipFileAtPathAsync(zipPath, versionDir);
      if (!unzipResult) {
        throw new Error('failed to unzip package');
      }

      this.writeConfig(manifest, `${versionDir}/config.json`);
      this.validatePackage(versionDir);
      this.writeConfig(manifest, this.fileManager.getJSAppConfigPath(manifest.appId));
    } catch (e) {
      if (fs.accessSync(versionDir)) {
        fs.rmdirSync(versionDir);
      }
      throw new Error(String(e));
    } finally {
      if (fs.accessSync(zipPath)) {
        fs.unlinkSync(zipPath);
      }
    }
  }

  private writeConfig(manifest: DMPRemoteUpdateManifest, path: string): void {
    const config: DMPRemoteManifestConfig = {
      appId: manifest.appId,
      name: manifest.name,
      path: manifest.path,
      versionCode: manifest.versionCode,
      versionName: manifest.versionName,
    };
    this.fileManager.writeJsonToFile(path, JSON.stringify(config));
  }

  private validatePackage(versionDir: string): void {
    const requiredFiles = [
      `${versionDir}/main/app-config.json`,
      `${versionDir}/main/logic.js`,
    ];
    const missingFile = requiredFiles.find((file) => !fs.accessSync(file));
    if (missingFile) {
      throw new Error(`package missing required file: ${missingFile.replace(versionDir + '/', '')}`);
    }
  }

  private async verifySha256(filePath: string, expectedSha256: string): Promise<void> {
    const stat = fs.statSync(filePath);
    const file = fs.openSync(filePath, fs.OpenMode.READ_ONLY);
    try {
      const buffer = new ArrayBuffer(stat.size);
      fs.readSync(file.fd, buffer);
      const md = cryptoFramework.createMd('SHA256');
      await md.update({ data: new Uint8Array(buffer) });
      const result = await md.digest();
      let actualSha256 = '';
      for (let i = 0; i < result.data.length; i++) {
        actualSha256 += result.data[i].toString(16).padStart(2, '0');
      }
      if (actualSha256.toLowerCase() !== expectedSha256.toLowerCase()) {
        throw new Error('package sha256 mismatch');
      }
    } finally {
      fs.closeSync(file);
    }
  }
}
