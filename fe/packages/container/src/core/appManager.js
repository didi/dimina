import { MiniApp } from '@/pages/miniApp/miniApp'
import { queryPath } from '@/utils/util'

export class AppManager {
	static appStack = []

	static openApp(opts, dimina) {
		const { appId, path, scene, destroy, name, logo } = opts
		const { pagePath, query } = queryPath(path)

		if (destroy) { // 打开新小程序前销毁之前的小程序视图
			for (const app of this.appStack) {
				if (app.appId !== appId) {
					const currentBridge = app.bridgeList.pop()
					currentBridge?.destroy()
					dimina.destroyRootView(app)
				}
			}
		}

		const cacheApp = this.getAppById(appId)

		if (cacheApp) {
			dimina.presentView(cacheApp, true)
		}
		else {
			const miniApp = new MiniApp({
				appId,
				scene,
				name,
				logo,
				pagePath,
				query,
			})

			this.appStack.push(miniApp)
			dimina.presentView(miniApp, false)
		}
	}

	static getAppById(appId) {
		for (const app of this.appStack) {
			if (app.appId === appId) {
				return app
			}
		}
		return null
	}

	static popView() {
		this.appStack.pop()
	}

	static closeApp(miniApp) {
		miniApp.parent.dismissView({
			destroy: false, // 关闭时是否销毁小程序容器
		})
	}
}
