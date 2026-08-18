import { invokeAPI, invokeAPIWithoutPromise } from '@/api/common'
import { invokeSafelyAll } from '@/core/safe-callback'
import { callback, isFunction } from '@dimina/common'

const uploadTaskInternals = new WeakMap()
const uploadTaskConstructorToken = Symbol('UploadTask constructor token')

function taskState(task) {
	const state = uploadTaskInternals.get(task)
	if (!state) throw new TypeError('Illegal invocation')
	return state
}

function project(value, fields) {
	const result = {}
	if (!value || typeof value !== 'object') return result
	for (const field of fields) {
		if (field in value) result[field] = value[field]
	}
	return result
}

function normalizeRecord(value) {
	if (!value || typeof value !== 'object') return undefined
	const result = Object.create(null)
	for (const key of Object.keys(value)) {
		result[key] = String(value[key])
	}
	return result
}

function sealTask(state) {
	if (state.terminal) return
	state.terminal = true
	callback.remove(state.progressCallbackId)
	callback.remove(state.headersCallbackId)
	state.progressListeners.clear()
	state.headersListeners.clear()
}

function addListener(task, key, listener) {
	if (!isFunction(listener)) return
	const state = taskState(task)
	if (!state.terminal) state[key].add(listener)
}

function removeListener(task, key, listener) {
	const listeners = taskState(task)[key]
	if (isFunction(listener)) listeners.delete(listener)
	else listeners.clear()
}

/**
 * https://developers.weixin.qq.com/miniprogram/dev/api/network/upload/UploadTask.html
 */
class UploadTask {
	constructor(token, state) {
		if (token !== uploadTaskConstructorToken) throw new TypeError('Illegal constructor')
		uploadTaskInternals.set(this, state)
	}

	abort() {
		const state = taskState(this)
		if (state.terminal) return
		sealTask(state)
		invokeAPIWithoutPromise('uploadFileTaskAbort', { taskId: state.taskId })
	}

	onProgressUpdate(listener) {
		addListener(this, 'progressListeners', listener)
	}

	offProgressUpdate(listener) {
		removeListener(this, 'progressListeners', listener)
	}

	onHeadersReceived(listener) {
		addListener(this, 'headersListeners', listener)
	}

	offHeadersReceived(listener) {
		removeListener(this, 'headersListeners', listener)
	}
}

/**
 * 将本地资源上传到服务器。
 * https://developers.weixin.qq.com/miniprogram/dev/api/network/upload/wx.uploadFile.html
 */
export function uploadFile(opts = {}) {
	const options = opts && typeof opts === 'object' ? opts : {}
	const taskId = `upload_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`
	const state = {
		taskId,
		terminal: false,
		progressCallbackId: undefined,
		headersCallbackId: undefined,
		progressListeners: new Set(),
		headersListeners: new Set(),
	}
	const task = new UploadTask(uploadTaskConstructorToken, state)

	state.progressCallbackId = callback.store((value) => {
		if (state.terminal) return
		const result = project(value, ['progress', 'totalBytesSent', 'totalBytesExpectedToSend'])
		invokeSafelyAll(undefined, [...state.progressListeners], [result], 'UploadTask.onProgressUpdate', false)
	}, true)
	state.headersCallbackId = callback.store((value) => {
		if (state.terminal) return
		const result = project(value, ['header'])
		invokeSafelyAll(undefined, [...state.headersListeners], [result], 'UploadTask.onHeadersReceived', false)
	}, true)

	const params = {
		taskId,
		progressCallback: state.progressCallbackId,
		headersCallback: state.headersCallbackId,
		url: options.url,
		filePath: options.filePath,
		name: options.name,
	}
	const header = normalizeRecord(options.header)
	const formData = normalizeRecord(options.formData)
	if (header !== undefined) params.header = header
	if (formData !== undefined) params.formData = formData
	for (const key of ['timeout', 'enableHttp2', 'enableQuic', 'enableProfile']) {
		if (options[key] !== undefined) params[key] = options[key]
	}

	params.success = (value) => {
		sealTask(state)
		if (isFunction(options.success)) {
			options.success(project(value, ['data', 'statusCode', 'profile', 'errMsg']))
		}
	}
	params.fail = (value) => {
		sealTask(state)
		if (isFunction(options.fail)) options.fail(value)
	}
	params.complete = (value) => {
		sealTask(state)
		if (isFunction(options.complete)) options.complete(value)
	}

	try {
		invokeAPI('uploadFile', params)
	}
	catch (error) {
		sealTask(state)
		throw error
	}
	return task
}
