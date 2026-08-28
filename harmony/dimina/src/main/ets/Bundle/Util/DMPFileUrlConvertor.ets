import { DMPContextUtils } from "../../Utils/DMPContextUtils";

export const DMPFileURLScheme: string = 'difile://';

// vPath example: difile://data/storage/el2/base/haps/entry/files/dm_bundles_v2/dd8a9edfa385c38808/resource
// localPath example: /data/storage/el2/base/haps/entry/files/dm_bundles_v2/dd8a9edfa385c38808/resource
// 涉及到worker线程，移除app相关逻辑，仅处理前缀

export class DMPFileUrlConvertor {
  //鸿蒙原生上传只支持internal://cache 协议
  static uri2UploadImageFilePath(url: string): string {
    const cacheDir = DMPContextUtils.getUIAbilityContext().cacheDir;
    const cacheUri = 'internal://cache'
    if (url.startsWith(DMPFileURLScheme)) {
      return url.replace(DMPFileURLScheme, cacheUri)
    } else if (url.startsWith(cacheDir)) {
      return url.replace(cacheDir, cacheUri)
    }
    return url
  }

  // 将虚拟路径转换为本地路径
  static localPathFromVPath(vPath: string): string {
    if (vPath.startsWith(DMPFileURLScheme)) {
      const localPath = vPath.replace(DMPFileURLScheme, "/");
      return localPath;
    }
    return vPath;
  }

  // 将本地路径转换为虚拟路径
  static vPathFromLocalPath(localPath: string): string {
    if (localPath.startsWith('/')) {
      const relativePath = localPath.replace(/^\//, DMPFileURLScheme);
      return relativePath;
    }
    return localPath;
  }

  static isDifilePath(path: string): boolean {
    return path.startsWith(DMPFileURLScheme);
  }
}

