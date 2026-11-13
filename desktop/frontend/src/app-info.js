import { generateAppLogo } from '../../../fe/packages/container/src/services/app-logo.js'

/** One icon source for the desktop list, launch screen, and mini program menu. */
export function getDesktopAppInfo(app) {
	return { ...app, logo: app.logo || generateAppLogo(app) }
}
