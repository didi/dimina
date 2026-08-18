import assert from 'node:assert/strict'
import test from 'node:test'

import {
	assertSafeTarget,
	isAllowedBrowserOrigin,
	isPublicAddress,
	sanitizeRequestHeaders,
} from './security.js'

test('blocks private, loopback, link-local, and reserved target addresses', () => {
	for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.1.1', '::1', 'fe80::1']) {
		assert.equal(isPublicAddress(address), false, address)
	}
	assert.equal(isPublicAddress('8.8.8.8'), true)
	assert.equal(isPublicAddress('2606:4700:4700::1111'), true)
})

test('validates every DNS answer before allowing a target', async () => {
	await assert.rejects(
		assertSafeTarget('https://example.test/path', async () => [
			{ address: '203.0.113.4', family: 4 },
		]),
		/private or reserved/,
	)
	await assert.doesNotReject(
		assertSafeTarget('https://example.test/path', async () => [
			{ address: '8.8.8.8', family: 4 },
		]),
	)
})

test('only allows browser origins from loopback or the explicit allowlist', () => {
	assert.equal(isAllowedBrowserOrigin('http://localhost:5173'), true)
	assert.equal(isAllowedBrowserOrigin('https://127.0.0.1:4173'), true)
	assert.equal(isAllowedBrowserOrigin('https://evil.example'), false)
	assert.equal(isAllowedBrowserOrigin('https://dev.example', 'https://dev.example'), true)
})

test('removes hop-by-hop and routing headers', () => {
	assert.deepEqual(sanitizeRequestHeaders({
		Authorization: 'Bearer token',
		Host: 'localhost',
		Connection: 'upgrade',
		'X-Request-ID': '123',
	}), {
		Authorization: 'Bearer token',
		'X-Request-ID': '123',
	})
})
