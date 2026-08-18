// 最小可用的小程序 app-config.json 形态，够 openApp 的启动链路（读取 entryPagePath /
// 页面配置 / 无 tabBar 分支）跑通，不代表真实编译产物的完整字段集合。
export const ENTRY_PAGE_PATH = 'pages/index/index'

export function createAppConfigResponse() {
	return {
		app: {
			entryPagePath: ENTRY_PAGE_PATH,
			pages: [ENTRY_PAGE_PATH],
			window: {},
		},
		modules: {
			[ENTRY_PAGE_PATH]: {},
		},
	}
}
