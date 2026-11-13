import { generateAppLogo } from './app-logo.js'

function memoize(func) {
	const cache = new Map()

	return function (...args) {
		const key = args.length === 1 ? args[0] : JSON.stringify(args)
		if (cache.has(key)) {
			return cache.get(key)
		}
		const result = func.apply(this, args)
		cache.set(key, result)
		return result
	}
}

export const getAppList = memoize(async () => {
	const appList = await fetch(`${import.meta.env.BASE_URL}appList.json`).then(res => res.json())
	appList.forEach((appInfo) => {
		const key = JSON.stringify(appInfo)
		const logo = sessionStorage.getItem(key)
		if (logo) {
			appInfo.logo = logo
		}
		else {
			const result = generateAppLogo(appInfo)
			sessionStorage.setItem(key, result)
			appInfo.logo = result
		}
	})
	return appList
})

// 模拟调用开放平台接口，获取应用信息
export async function getMiniAppInfo(appId) {
	const appList = await getAppList()
	for (const app of appList) {
		if (app.appId === appId) {
			return app
		}
	}
}

function ensureTrailingSlash(url) {
	return url.endsWith('/') ? url : `${url}/`
}

/**
 * Resolve a remotely published mini program from its manifest.
 *
 * Web does not unpack the native zip package. The compiled directory must be
 * deployed as static files under `<resourceBaseUrl>/<appId>/`. `webBaseUrl`
 * may override the manifest directory when those resources are hosted
 * elsewhere.
 */
export async function getMiniAppManifest(manifestUrl) {
	const resolvedManifestUrl = new URL(manifestUrl, window.location.href)
	const response = await fetch(resolvedManifestUrl)
	if (!response.ok) {
		throw new Error(`manifest request failed: HTTP ${response.status}`)
	}

	const root = await response.json()
	const manifest = root?.data ?? root
	if (!manifest || typeof manifest !== 'object') {
		throw new Error('manifest is not an object')
	}
	if (!manifest.appId) {
		throw new Error('manifest missing appId')
	}
	if (!manifest.path) {
		throw new Error('manifest missing path')
	}

	const configuredBaseUrl = manifest.webBaseUrl || manifest.baseUrl
	const resourceBaseUrl = configuredBaseUrl
		? new URL(configuredBaseUrl, resolvedManifestUrl)
		: new URL('./', resolvedManifestUrl)

	return {
		...manifest,
		manifestUrl: resolvedManifestUrl.href,
		resourceBaseUrl: ensureTrailingSlash(resourceBaseUrl.href),
	}
}

/**
 * manifestUrl 安装的小程序托管在别处：resourceBaseUrl 由 manifest 给出，不是本地编译产物。
 * sessionStorage 记一份 appId -> manifestUrl，页面刷新后 URL 上只剩 appId 时也能重新取到
 * 同一个 resourceBaseUrl；manifest 的 name/logo 顺带缓存进 manifestInfoCache，喂给
 * container-sdk 的 getAppInfo(appId)（唯一的名称/图标来源，不区分安装方式）。
 */
export const manifestInfoCache = new Map()

export async function resolveManifestResourceBaseUrl(appId, manifestUrl) {
	const effectiveManifestUrl = manifestUrl || (appId ? sessionStorage.getItem(`dimina:manifest:${appId}`) : null)
	if (!effectiveManifestUrl) {
		return null
	}
	const manifest = await getMiniAppManifest(effectiveManifestUrl)
	if (appId && manifest.appId !== appId) {
		throw new Error(`manifest appId ${manifest.appId} does not match ${appId}`)
	}
	sessionStorage.setItem(`dimina:manifest:${manifest.appId}`, manifest.manifestUrl)
	manifestInfoCache.set(manifest.appId, { name: manifest.name, logo: manifest.logo })
	return manifest
}
