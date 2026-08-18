const DEFAULT_TIMEOUT_MS = 60000
const MAX_TIMEOUT_MS = 0x7FFFFFFF
const MAX_REASON_UTF8_BYTES = 123

const DISALLOWED_HEADER_NAMES = new Set([
	'connection',
	'content-length',
	'host',
	'referer',
	'sec-websocket-accept',
	'sec-websocket-extensions',
	'sec-websocket-key',
	'sec-websocket-protocol',
	'sec-websocket-version',
	'upgrade',
])

const HTTP_TOKEN_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const HEADER_VALUE_ALLOWED = /^[\t\x20-\x7E]*$/
const URL_FORBIDDEN_CHARACTERS = new Set(['"', '<', '>', '{', '}', '|', '\\', '^', '`'])
const URL_INCOMPLETE_PERCENT_ESCAPE = /%(?![0-9A-Fa-f]{2})/

function containsForbiddenUrlCharacter(value: string): boolean {
	for (const character of value) {
		const code = character.charCodeAt(0)
		if (code <= 0x20 || code === 0x7F || URL_FORBIDDEN_CHARACTERS.has(character)) return true
	}
	return false
}

type ValidationResult<T> =
	| { ok: true, value: T }
	| { ok: false, error: string }

function success<T>(value: T): ValidationResult<T> {
	return { ok: true, value }
}

function failure<T>(error: string): ValidationResult<T> {
	return { ok: false, error }
}

function configuredTimeoutOrDefault(appDefaultMs?: number): number {
	if (typeof appDefaultMs !== 'number' || !Number.isFinite(appDefaultMs) || appDefaultMs < 1 || appDefaultMs > MAX_TIMEOUT_MS) {
		return DEFAULT_TIMEOUT_MS
	}
	return Math.floor(appDefaultMs)
}

/** Web 容器与 Android/iOS/HarmonyOS 共用的 WebSocket 参数校验。 */
export const WebSocketValidation = {
	DEFAULT_TIMEOUT_MS,
	MAX_TIMEOUT_MS,
	MAX_REASON_UTF8_BYTES,

	validateUrl(rawUrl: unknown): ValidationResult<string> {
		if (typeof rawUrl !== 'string' || rawUrl.length === 0) {
			return failure('invalid url')
		}
		// URL 会主动 trim 空白、补写转义；先检查原串，不能让容器静默连接到调用方没有写出的地址。
		if (!/^wss:\/\/[^/?#]/i.test(rawUrl) || containsForbiddenUrlCharacter(rawUrl) || URL_INCOMPLETE_PERCENT_ESCAPE.test(rawUrl) || rawUrl.includes('#')) {
			return failure('invalid url')
		}
		try {
			const parsed = new URL(rawUrl)
			if (parsed.protocol.toLowerCase() !== 'wss:' || parsed.hostname.length === 0) {
				return failure('invalid url')
			}
		}
		catch {
			return failure('invalid url')
		}
		return success(rawUrl)
	},

	validateTimeout(rawTimeout: unknown, appDefaultMs?: number): ValidationResult<number> {
		const fallback = configuredTimeoutOrDefault(appDefaultMs)
		if (rawTimeout === undefined || rawTimeout === null) {
			return success(fallback)
		}
		if (typeof rawTimeout !== 'number' || !Number.isFinite(rawTimeout) || rawTimeout > MAX_TIMEOUT_MS) {
			return failure('invalid timeout')
		}
		if (rawTimeout < 1) {
			return success(fallback)
		}
		return success(Math.floor(rawTimeout))
	},

	validateProtocols(rawProtocols: unknown): ValidationResult<string[]> {
		if (rawProtocols === undefined || rawProtocols === null) {
			return success([])
		}
		if (!Array.isArray(rawProtocols)) {
			return failure('protocols must be an array')
		}
		const protocols: string[] = []
		for (const protocol of rawProtocols) {
			if (typeof protocol !== 'string' || protocol.length === 0) {
				return failure('invalid protocol')
			}
			protocols.push(protocol)
		}
		return success(protocols)
	},

	validateHeader(rawHeader: unknown): ValidationResult<Record<string, string>> {
		const header: Record<string, string> = {}
		if (rawHeader === undefined || rawHeader === null) {
			return success(header)
		}
		if (typeof rawHeader !== 'object' || Array.isArray(rawHeader)) {
			return failure('header must be an object')
		}
		for (const rawName of Object.keys(rawHeader)) {
			if (rawName.includes('\r') || rawName.includes('\n')) {
				return failure('invalid header')
			}
			const name = rawName.trim()
			if (!name || DISALLOWED_HEADER_NAMES.has(name.toLowerCase())) {
				continue
			}
			if (!HTTP_TOKEN_NAME.test(name)) {
				return failure('invalid header')
			}
			const rawValue = (rawHeader as Record<string, unknown>)[rawName]
			if (rawValue === undefined || rawValue === null) {
				continue
			}
			const value = String(rawValue)
			if (!HEADER_VALUE_ALLOWED.test(value)) {
				return failure('invalid header')
			}
			header[name] = value
		}
		return success(header)
	},

	validateCloseCode(rawCode: unknown): ValidationResult<number> {
		if (rawCode === undefined || rawCode === null) {
			return success(1000)
		}
		if (typeof rawCode !== 'number' || !Number.isFinite(rawCode) || !Number.isInteger(rawCode)) {
			return failure('invalid code')
		}
		if (rawCode !== 1000 && (rawCode < 3000 || rawCode > 4999)) {
			return failure('invalid code')
		}
		return success(rawCode)
	},

	validateReason(rawReason: unknown): ValidationResult<string> {
		if (rawReason === undefined || rawReason === null) {
			return success('')
		}
		if (typeof rawReason !== 'string') {
			return failure('reason must be a string')
		}
		if (new TextEncoder().encode(rawReason).byteLength > MAX_REASON_UTF8_BYTES) {
			return failure('reason must not exceed 123 UTF-8 bytes')
		}
		return success(rawReason)
	},
}

export type { ValidationResult }
