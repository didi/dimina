import { invokeAPI } from '@/api/common'

/**
 * 自定义分析数据上报接口。使用前，需要在小程序管理后台自定义分析中新建事件，配置好事件名与字段。
 * https://developers.weixin.qq.com/miniprogram/dev/api/data-analysis/wx.reportAnalytics.html
 */
export function reportAnalytics(...opts) {
	return invokeAPI('reportAnalytics', opts)
}

export function reportEvent(eventId, data) {
	return invokeAPI('reportAnalytics', { eventId, data })
}
