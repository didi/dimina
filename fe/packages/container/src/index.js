import { AppManager } from '@/core/appManager'
import { Application } from '@/pages/application/application'
import { AppList } from '@/pages/appList/appList'
import { Device } from '@/pages/device/device'
import { HashRouter } from '@/utils/hashRouter'
import '@/styles/app.scss'

window.onload = function () {
	const device = new Device()
	const application = new Application()
	const appListPage = new AppList()
	application.initRootView(appListPage)
	device.open(application)

  // restore miniapp
	const parsed = HashRouter.parse(window.location.hash)
	if (parsed) {
		AppManager.openApp({
			appId: parsed.appId,
			path: parsed.path,
			scene: 1001,
			destroy: true,
		}, application)
	}
}
