import { generateAppLogo } from './app-logo.js'

const logos = new Map()

/** Resolve one icon for the list, launch screen and application menu. */
export function getAppInfo(app) {
	const name = app.name || app.appId || '小程序'
	if (app.logo) return { ...app, name }
	const key = `dimina:app-logo:${name}`
	let logo = logos.get(key)
	if (!logo) {
		try { logo = globalThis.sessionStorage?.getItem(key) }
		catch { /* WebView storage may be unavailable; the in-memory cache still works. */ }
		logo ||= generateAppLogo({ ...app, name })
		logos.set(key, logo)
		try { globalThis.sessionStorage?.setItem(key, logo) }
		catch { /* The generated icon does not depend on persistent browser storage. */ }
	}
	return { ...app, name, logo }
}
