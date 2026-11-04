import fonts from '../../../../core/font-face'
import router from '../../../../core/router'
import { invokeSafely } from '../../../../core/safe-callback'
import { dispatchBackgroundWork } from '../../../../core/background-scheduler'

/** Load a web font; dimina-font:// IDs refer to fonts registered by the host. */
export function loadFontFace(options = {}) {
	const deferred = fonts.load(options, router.getPageInfo().id).then(
		() => ({ errMsg: 'loadFontFace:ok', status: 'loaded' }),
		// wx asynchronous APIs reject their result object, matching invokePromiseAPI.
		// eslint-disable-next-line prefer-promise-reject-errors
		error => Promise.reject({ errMsg: `loadFontFace:fail ${error.message}`, status: 'failed' }),
	)
	const promise = new Promise((resolve, reject) => {
		deferred.then(result => dispatchBackgroundWork(() => resolve(result)),
			result => dispatchBackgroundWork(() => reject(result)))
	})
	if (!['success', 'fail', 'complete'].some(name => typeof options?.[name] === 'function')) return promise
	const finish = (name, result) => {
		if (typeof options[name] === 'function') invokeSafely(null, options[name], [result], `loadFontFace ${name}`)
		if (typeof options.complete === 'function') invokeSafely(null, options.complete, [result], 'loadFontFace complete')
	}
	promise.then(result => finish('success', result), result => finish('fail', result))
}
