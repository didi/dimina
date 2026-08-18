import { DMPContextUtils } from "../../Utils/DMPContextUtils";

const DMPFileURLScheme: string = 'difile://';
const DMPCanvasTempPrefix: string = `${DMPFileURLScheme}canvas/`;

// vPath example: difile://data/storage/el2/base/haps/entry/files/dm_bundles_v2/dd8a9edfa385c38808/resource
// localPath example: /data/storage/el2/base/haps/entry/files/dm_bundles_v2/dd8a9edfa385c38808/resource
// 涉及到worker线程，移除app相关逻辑，仅处理前缀

export class DMPFileUrlConvertor {
  //鸿蒙原生上传只支持internal://cache 协议
  static uri2UploadImageFilePath(url: string): string {
    const cacheDir = DMPContextUtils.getUIAbilityContext().cacheDir;
    const cacheUri = 'internal://cache'
    if (url.startsWith("difile://")) {
      return url.replace("difile://", cacheUri)
    } else if (url.startsWith(cacheDir)) {
      return url.replace(cacheDir, cacheUri)
    }
    return url
  }

  // 将虚拟路径转换为本地路径
  static localPathFromVPath(vPath: string, canvasTempRoot: string = ''): string {
    const canvasFileName = DMPFileUrlConvertor.canvasTempFileName(vPath);
    if (canvasFileName) {
      if (!canvasTempRoot) return vPath;
      return `${canvasTempRoot.replace(/\/+$/, '')}/${canvasFileName}`;
    }
    if (vPath.startsWith(DMPFileURLScheme)) {
      const localPath = vPath.replace(/^difile:\/\//, "/");
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

  static canvasTempRoot(appId: string): string {
    if (appId === '.' || appId === '..' || !/^[A-Za-z0-9._-]+$/.test(appId)) return '';
    return `${DMPContextUtils.getUIAbilityContext().filesDir}/dimina/${appId}/resource/tmp`;
  }

  // 路径归属判定的唯一入口。空 root 一律不放行：canvasTempRoot() 对不合法的 appId 返回空串，
  // 而空串会让 `path.startsWith('/')` 对任何绝对路径都成立，校验失败反而把整条白名单打穿。
  static isUnderAnyRoot(path: string, roots: Array<string>): boolean {
    return roots.some((root: string) => root.length > 0 && (path === root || path.startsWith(`${root}/`)));
  }

  static canvasTempVPath(fileName: string): string {
    return `${DMPCanvasTempPrefix}${fileName}`;
  }

  static canvasTempFileName(vPath: string): string {
    if (!vPath.startsWith(DMPCanvasTempPrefix)) return '';
    const fileName = vPath.substring(DMPCanvasTempPrefix.length);
    return /^canvas_[0-9a-f-]+\.(png|jpg)$/.test(fileName) ? fileName : '';
  }
}

