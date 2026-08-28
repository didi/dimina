import fs from '@ohos.file.fs';
import { DMPContextUtils } from '../../Utils/DMPContextUtils';
import { DMPFileURLScheme as VIRTUAL_PREFIX, DMPFileUrlConvertor } from './DMPFileUrlConvertor';
const USER_PREFIX = 'usr';
const TEMP_PREFIX = 'tmp';

/**
 * Resolve mini-program file paths without allowing one app to escape into
 * another app's files, shared cache entries, or host-owned paths.
 */
export class DMPFilePathResolver {
  static userRoot(appId: string): string {
    const safeAppId = DMPFilePathResolver.normalizeAppId(appId);
    const root = `${DMPContextUtils.getUIAbilityContext().filesDir}/dimina-file-system/${safeAppId}/${USER_PREFIX}`;
    DMPFilePathResolver.ensureDirectory(root);
    return DMPFilePathResolver.normalizeAbsolutePath(root);
  }

  static tempRoot(appId: string): string {
    const safeAppId = DMPFilePathResolver.normalizeAppId(appId);
    const root = `${DMPContextUtils.getUIAbilityContext().cacheDir}/dimina-file-system/${safeAppId}/${TEMP_PREFIX}`;
    DMPFilePathResolver.ensureDirectory(root);
    return DMPFilePathResolver.normalizeAbsolutePath(root);
  }

  static legacyTempRoot(appId: string): string {
    const safeAppId = DMPFilePathResolver.normalizeAppId(appId);
    const root = `${DMPContextUtils.getUIAbilityContext().filesDir}/dimina/${safeAppId}/resource/tmp`;
    return DMPFilePathResolver.normalizeAbsolutePath(root);
  }

  static resolve(rawPath: string, appId: string, packageRoot?: string): string {
    if (!rawPath) {
      throw new Error('missing file path');
    }
    const userRoot = DMPFilePathResolver.userRoot(appId);
    const tempRoot = DMPFilePathResolver.tempRoot(appId);
    let candidate = rawPath;

    if (rawPath === `${VIRTUAL_PREFIX}${USER_PREFIX}` || rawPath.startsWith(`${VIRTUAL_PREFIX}${USER_PREFIX}/`)) {
      const relative = rawPath.substring(`${VIRTUAL_PREFIX}${USER_PREFIX}`.length).replace(/^\/+/, '');
      candidate = `${userRoot}/${relative}`;
    } else if (rawPath === `${VIRTUAL_PREFIX}${TEMP_PREFIX}` || rawPath.startsWith(`${VIRTUAL_PREFIX}${TEMP_PREFIX}/`)) {
      const relative = rawPath.substring(`${VIRTUAL_PREFIX}${TEMP_PREFIX}`.length).replace(/^\/+/, '');
      candidate = `${tempRoot}/${relative}`;
    } else if (rawPath.startsWith(VIRTUAL_PREFIX)) {
      candidate = DMPFileUrlConvertor.localPathFromVPath(rawPath, DMPFilePathResolver.legacyTempRoot(appId));
    } else if (!rawPath.startsWith('/')) {
      if (!packageRoot) {
        throw new Error(`permission denied, open ${rawPath}`);
      }
      return DMPFilePathResolver.resolvePackagePath(rawPath, packageRoot);
    }

    const path = DMPFilePathResolver.normalizeAbsolutePath(candidate);
    const normalizedPackageRoot = packageRoot ? DMPFilePathResolver.normalizeAbsolutePath(packageRoot) : '';
    const legacyTempRoot = DMPFilePathResolver.legacyTempRoot(appId);
    const allowedRoot = [userRoot, tempRoot, legacyTempRoot, normalizedPackageRoot]
      .find((root: string) => root.length > 0 && DMPFilePathResolver.isWithin(path, root));
    if (!allowedRoot) {
      throw new Error(`permission denied, open ${rawPath}`);
    }
    DMPFilePathResolver.assertNoSymbolicLinks(path, allowedRoot);
    return path;
  }

  static ensureDirectory(path: string): void {
    if (!fs.accessSync(path)) {
      fs.mkdirSync(path, true);
    }
  }

  private static resolvePackagePath(rawPath: string, packageRoot: string): string {
    const relative = DMPFilePathResolver.normalizeRelativePath(rawPath);
    const root = DMPFilePathResolver.normalizeAbsolutePath(packageRoot);
    const direct = DMPFilePathResolver.normalizeAbsolutePath(`${root}/${relative}`);
    const main = DMPFilePathResolver.normalizeAbsolutePath(`${root}/main/${relative}`);
    const candidate = fs.accessSync(direct) ? direct : main;
    if (!DMPFilePathResolver.isWithin(candidate, root)) {
      throw new Error(`permission denied, open ${rawPath}`);
    }
    DMPFilePathResolver.assertNoSymbolicLinks(candidate, root);
    return candidate;
  }

  private static normalizeRelativePath(path: string): string {
    if (path.includes('\\') || path.includes('\0')) {
      throw new Error('invalid file path');
    }
    const segments = path.split('/').filter((segment: string) => segment.length > 0 && segment !== '.');
    if (segments.length === 0 || segments.some((segment: string) => segment === '..')) {
      throw new Error('invalid file path');
    }
    return segments.join('/');
  }

  private static normalizeAppId(appId: string): string {
    if (!/^[A-Za-z0-9._-]+$/.test(appId)) {
      throw new Error('invalid app id');
    }
    return appId;
  }

  private static normalizeAbsolutePath(path: string): string {
    if (!path.startsWith('/') || path.includes('\\') || path.includes('\0')) {
      throw new Error('invalid file path');
    }
    const normalized = new Array<string>();
    path.split('/').forEach((segment: string) => {
      if (!segment || segment === '.') {
        return;
      }
      if (segment === '..') {
        if (normalized.length === 0) {
          throw new Error('invalid file path');
        }
        normalized.pop();
        return;
      }
      normalized.push(segment);
    });
    return `/${normalized.join('/')}`;
  }

  private static isWithin(path: string, root: string): boolean {
    return path === root || path.startsWith(`${root}/`);
  }

  private static assertNoSymbolicLinks(path: string, root: string): void {
    const relative = path.substring(root.length).replace(/^\/+/, '');
    let current = root;
    if (fs.accessSync(current) && fs.lstatSync(current).isSymbolicLink()) {
      throw new Error('symbolic links are not allowed');
    }
    relative.split('/').filter((segment: string) => segment.length > 0).forEach((segment: string) => {
      current = `${current}/${segment}`;
      if (fs.accessSync(current) && fs.lstatSync(current).isSymbolicLink()) {
        throw new Error('symbolic links are not allowed');
      }
    });
  }
}
