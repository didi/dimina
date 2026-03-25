import { AppManager } from '@/core/appManager'
import { Application } from '@/pages/application/application'
import { HashRouter } from '@/utils/hashRouter'
import '@/styles/app.scss'

export { AppManager, Application, HashRouter }

export function openWithHash(root) {
	const application = new Application()
	root.appendChild(application.el)

	const parsed = HashRouter.parse(window.location.hash)
	if (parsed) {
		AppManager.openApp({
			appId: parsed.appId,
			path: parsed.path,
			scene: 1001,
			destroy: true,
		}, application)
	}

	return application
}
