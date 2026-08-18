import dns from 'node:dns'
import net from 'node:net'

const blockedAddresses = new net.BlockList()

for (const [address, prefix] of [
	['0.0.0.0', 8],
	['10.0.0.0', 8],
	['100.64.0.0', 10],
	['127.0.0.0', 8],
	['169.254.0.0', 16],
	['172.16.0.0', 12],
	['192.0.0.0', 24],
	['192.0.2.0', 24],
	['192.168.0.0', 16],
	['198.18.0.0', 15],
	['198.51.100.0', 24],
	['203.0.113.0', 24],
	['224.0.0.0', 4],
	['240.0.0.0', 4],
]) {
	blockedAddresses.addSubnet(address, prefix, 'ipv4')
}

for (const [address, prefix] of [
	['::', 128],
	['::1', 128],
	['64:ff9b:1::', 48],
	['100::', 64],
	['2001:db8::', 32],
	['fc00::', 7],
	['fe80::', 10],
	['ff00::', 8],
]) {
	blockedAddresses.addSubnet(address, prefix, 'ipv6')
}

const BLOCKED_REQUEST_HEADERS = new Set([
	'connection',
	'content-length',
	'forwarded',
	'host',
	'origin',
	'proxy-authenticate',
	'proxy-authorization',
	'referer',
	'te',
	'trailer',
	'transfer-encoding',
	'upgrade',
	'via',
])

function unsafeTargetError(message) {
	const error = new Error(message)
	error.code = 'DIMINA_UNSAFE_TARGET'
	return error
}

function normalizeHostname(hostname) {
	const withoutBrackets = hostname.startsWith('[') && hostname.endsWith(']')
		? hostname.slice(1, -1)
		: hostname
	return withoutBrackets.replace(/\.$/, '').toLowerCase()
}

export function isPublicAddress(address) {
	// Reject IPv4-mapped IPv6 literals instead of letting their alternate
	// representation bypass the IPv4 ranges above.
	if (address.toLowerCase().startsWith('::ffff:')) return false
	const family = net.isIP(address)
	if (family === 0) return false
	return !blockedAddresses.check(address, family === 4 ? 'ipv4' : 'ipv6')
}

function assertPublicAddresses(addresses) {
	if (!Array.isArray(addresses) || addresses.length === 0) {
		throw unsafeTargetError('Target hostname did not resolve')
	}
	for (const entry of addresses) {
		if (!isPublicAddress(entry.address)) {
			throw unsafeTargetError('Requests to private or reserved networks are not allowed')
		}
	}
}

export async function assertSafeTarget(rawUrl, lookup = dns.promises.lookup) {
	if (typeof rawUrl !== 'string' || rawUrl.trim() === '') {
		throw unsafeTargetError('URL is required')
	}

	let target
	try {
		target = new URL(rawUrl)
	}
	catch {
		throw unsafeTargetError('Invalid URL')
	}

	if (!['http:', 'https:'].includes(target.protocol)) {
		throw unsafeTargetError('Only HTTP and HTTPS URLs are allowed')
	}
	if (target.username || target.password) {
		throw unsafeTargetError('Credentials in target URLs are not allowed')
	}

	const hostname = normalizeHostname(target.hostname)
	const family = net.isIP(hostname)
	const addresses = family
		? [{ address: hostname, family }]
		: await lookup(hostname, { all: true, verbatim: true })
	assertPublicAddresses(addresses)

	return target
}

export function createSafeLookup(lookup = dns.lookup) {
	return (hostname, options, callback) => {
		const normalizedOptions = typeof options === 'number'
			? { family: options }
			: { ...(options ?? {}) }
		lookup(hostname, { ...normalizedOptions, all: true, verbatim: true }, (error, addresses) => {
			if (error) {
				callback(error)
				return
			}
			try {
				assertPublicAddresses(addresses)
			}
			catch (validationError) {
				callback(validationError)
				return
			}

			if (normalizedOptions.all) {
				callback(null, addresses)
			}
			else {
				const [{ address, family }] = addresses
				callback(null, address, family)
			}
		})
	}
}

export function isAllowedBrowserOrigin(origin, configuredOrigins = '') {
	if (!origin) return true

	const explicitOrigins = new Set(String(configuredOrigins)
		.split(',')
		.map(value => value.trim())
		.filter(Boolean))
	if (explicitOrigins.has(origin)) return true

	try {
		const parsed = new URL(origin)
		const hostname = normalizeHostname(parsed.hostname)
		return ['http:', 'https:'].includes(parsed.protocol)
			&& ['localhost', '127.0.0.1', '::1'].includes(hostname)
	}
	catch {
		return false
	}
}

export function sanitizeRequestHeaders(headers) {
	if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return {}

	return Object.fromEntries(Object.entries(headers).filter(([name]) => {
		const normalizedName = name.toLowerCase()
		return !BLOCKED_REQUEST_HEADERS.has(normalizedName) && !normalizedName.startsWith('proxy-')
	}))
}
