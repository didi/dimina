import { beforeEach, describe, expect, it, vi } from 'vitest'

let api

async function loadUploadApi() {
	vi.resetModules()
	globalThis.DiminaServiceBridge = {
		onMessage: null,
		invoke: vi.fn(() => 'invoke-result'),
		publish: vi.fn(() => 'publish-result'),
	}
	const [upload, common] = await Promise.all([
		import('@/api/core/network/upload/index.js'),
		import('@dimina/common'),
	])
	const bridge = globalThis.DiminaServiceBridge
	const paramsOf = name => bridge.invoke.mock.calls
		.filter(call => call[0].body.name === name)
		.map(call => call[0].body.params)
	return { ...upload, callback: common.callback, bridge, paramsOf }
}

beforeEach(async () => {
	api = await loadUploadApi()
})

describe('wx.uploadFile / UploadTask 公开形状', () => {
	it('同步返回 UploadTask，原型只公开官方五个方法', () => {
		const task = api.uploadFile({ url: 'https://example.com', filePath: 'difile://a.jpg', name: 'photo' })
		const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(task)).sort()

		expect(task).not.toBeInstanceOf(Promise)
		expect(Object.keys(task)).toEqual([])
		expect(methods).toEqual([
			'abort',
			'constructor',
			'offHeadersReceived',
			'offProgressUpdate',
			'onHeadersReceived',
			'onProgressUpdate',
		].sort())
	})

	it('只向 native 下发官方参数与内部任务协议字段', () => {
		api.uploadFile({
			url: 'https://example.com',
			filePath: 'difile://a.jpg',
			name: 'photo',
			header: { Authorization: 123 },
			formData: { user: 'alice', enabled: true },
			timeout: 5000,
			unknown: 'must-not-leak',
		})
		const params = api.paramsOf('uploadFile')[0]

		expect(params).toMatchObject({
			url: 'https://example.com',
			filePath: 'difile://a.jpg',
			name: 'photo',
			header: { Authorization: '123' },
			formData: { user: 'alice', enabled: 'true' },
			timeout: 5000,
			taskId: expect.stringMatching(/^upload_/),
			progressCallback: expect.any(String),
			headersCallback: expect.any(String),
		})
		expect(params).not.toHaveProperty('unknown')
	})
})

describe('UploadTask 事件与取消', () => {
	it('投影进度和响应头事件，并支持按函数或全部移除监听', () => {
		const task = api.uploadFile({ url: 'https://example.com', filePath: 'difile://a.jpg', name: 'photo' })
		const params = api.paramsOf('uploadFile')[0]
		const progressA = vi.fn()
		const progressB = vi.fn()
		const headers = vi.fn()
		task.onProgressUpdate(progressA)
		task.onProgressUpdate(progressB)
		task.offProgressUpdate(progressA)
		task.onHeadersReceived(headers)

		api.callback.invoke(params.progressCallback, {
			progress: 50,
			totalBytesSent: 5,
			totalBytesExpectedToSend: 10,
			internal: true,
		})
		api.callback.invoke(params.headersCallback, { header: { ETag: 'x' }, statusCode: 200 })

		expect(progressA).not.toHaveBeenCalled()
		expect(progressB).toHaveBeenCalledWith({
			progress: 50,
			totalBytesSent: 5,
			totalBytesExpectedToSend: 10,
		})
		expect(headers).toHaveBeenCalledWith({ header: { ETag: 'x' } })

		task.offProgressUpdate()
		task.offHeadersReceived()
		api.callback.invoke(params.progressCallback, { progress: 100 })
		api.callback.invoke(params.headersCallback, { header: {} })
		expect(progressB).toHaveBeenCalledTimes(1)
		expect(headers).toHaveBeenCalledTimes(1)
	})

	it('abort 下发 taskId、返回 void，并让后续任务事件失效', () => {
		const task = api.uploadFile({ url: 'https://example.com', filePath: 'difile://a.jpg', name: 'photo' })
		const uploadParams = api.paramsOf('uploadFile')[0]
		const progress = vi.fn()
		task.onProgressUpdate(progress)

		expect(task.abort()).toBeUndefined()
		expect(api.paramsOf('uploadFileTaskAbort')).toEqual([{ taskId: uploadParams.taskId }])
		api.callback.invoke(uploadParams.progressCallback, { progress: 20 })
		expect(progress).not.toHaveBeenCalled()
	})

	it('重复 abort 只下发一次', () => {
		const task = api.uploadFile({ url: 'https://example.com', filePath: 'difile://a.jpg', name: 'photo' })

		task.abort()
		task.abort()

		expect(api.paramsOf('uploadFileTaskAbort')).toHaveLength(1)
	})
})

describe('上传终态', () => {
	it('success 只暴露官方结果字段并封存任务事件', () => {
		const success = vi.fn()
		const progress = vi.fn()
		const task = api.uploadFile({
			url: 'https://example.com', filePath: 'difile://a.jpg', name: 'photo', success,
		})
		const params = api.paramsOf('uploadFile')[0]
		task.onProgressUpdate(progress)

		api.callback.invoke(params.success, {
			data: 'ok', statusCode: 201, errMsg: 'uploadFile:ok', internal: true,
		})
		api.callback.invoke(params.progressCallback, { progress: 100 })

		expect(success).toHaveBeenCalledWith({ data: 'ok', statusCode: 201, errMsg: 'uploadFile:ok' })
		expect(progress).not.toHaveBeenCalled()
	})

	it('fail 和 complete 收到 native 的同一终态结果', () => {
		const fail = vi.fn()
		const complete = vi.fn()
		api.uploadFile({
			url: 'https://example.com', filePath: 'difile://a.jpg', name: 'photo', fail, complete,
		})
		const params = api.paramsOf('uploadFile')[0]
		const result = { errMsg: 'uploadFile:fail abort' }

		api.callback.invoke(params.fail, result)
		api.callback.invoke(params.complete, result)

		expect(fail).toHaveBeenCalledWith(result)
		expect(complete).toHaveBeenCalledWith(result)
	})
})
