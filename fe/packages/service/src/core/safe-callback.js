import { isFunction } from '@dimina/common'
import { reportAppError } from './app-events'

const reportingErrors = new WeakSet()

function reportCallbackError(ctx, error, label) {
	if (ctx && (typeof ctx === 'object' || typeof ctx === 'function') && !reportingErrors.has(ctx)) {
		reportingErrors.add(ctx)
		try {
			if (isFunction(ctx.componentError)) {
				ctx.componentError(error)
			}
		}
		catch (errorHandlerError) {
			console.error('[service] error lifetime error:', errorHandlerError)
		}
		finally {
			reportingErrors.delete(ctx)
		}
	}

	reportAppError(error)
	console.error(`[service] ${label} error:`, error)
}

/**
 * Invoke a user callback synchronously while isolating its exception.
 *
 * This intentionally does not await callback return values. exparser/glass-easel
 * lifecycle and observer dispatch stays in the current call stack, while an
 * exception from one callback must not prevent the remaining callbacks or tree
 * traversal from running.
 */
export function invokeSafely(ctx, callback, args = [], label = 'callback', reportToComponent = true) {
	if (!isFunction(callback)) {
		return undefined
	}

	try {
		return callback.apply(ctx, args)
	}
	catch (error) {
		if (reportToComponent) {
			reportCallbackError(ctx, error, label)
		}
		else {
			reportAppError(error)
			console.error(`[service] ${label} error:`, error)
		}
		return undefined
	}
}

export function invokeSafelyAll(ctx, callbacks, args = [], label = 'callback', reportToComponent = true) {
	for (const callback of callbacks || []) {
		invokeSafely(ctx, callback, args, label, reportToComponent)
	}
}
