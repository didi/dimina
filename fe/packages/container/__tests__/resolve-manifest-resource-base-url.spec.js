import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { manifestInfoCache, resolveManifestResourceBaseUrl } from '../src/services'

function stubManifestFetch(manifest) {
	vi.stubGlobal('window', {
		location: { href: 'https://container.example.com/index.html' },
	})
	vi.stubGlobal('fetch', vi.fn(async () => ({
		ok: true,
		status: 200,
		json: async () => manifest,
	})))
}

describe('resolveManifestResourceBaseUrl', () => {
	let sessionStorageStub

	beforeEach(() => {
		manifestInfoCache.clear()
		sessionStorageStub = {
			getItem: vi.fn(() => null),
			setItem: vi.fn(),
		}
		vi.stubGlobal('sessionStorage', sessionStorageStub)
	})

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it('returns null without fetching when neither manifestUrl nor a stored one exists', async () => {
		const result = await resolveManifestResourceBaseUrl('local-app', null)

		expect(result).toBeNull()
		expect(sessionStorageStub.getItem).toHaveBeenCalledWith('dimina:manifest:local-app')
	})

	it('resolves via manifestUrl, persists it keyed by appId, and caches name/logo', async () => {
		stubManifestFetch({
			appId: 'remote-app',
			name: 'Remote App',
			logo: 'https://cdn.example.com/logo.png',
			path: 'pages/index',
		})

		const manifest = await resolveManifestResourceBaseUrl(null, 'https://cdn.example.com/manifests/app.json')

		expect(manifest).toMatchObject({ appId: 'remote-app', path: 'pages/index' })
		expect(sessionStorageStub.setItem).toHaveBeenCalledWith(
			'dimina:manifest:remote-app',
			'https://cdn.example.com/manifests/app.json',
		)
		expect(manifestInfoCache.get('remote-app')).toEqual({
			name: 'Remote App',
			logo: 'https://cdn.example.com/logo.png',
		})
	})

	it('falls back to the sessionStorage-remembered manifestUrl when only appId is given (refresh recovery)', async () => {
		sessionStorageStub.getItem = vi.fn(() => 'https://cdn.example.com/manifests/app.json')
		stubManifestFetch({ appId: 'remote-app', path: 'pages/index' })

		const manifest = await resolveManifestResourceBaseUrl('remote-app', null)

		expect(sessionStorageStub.getItem).toHaveBeenCalledWith('dimina:manifest:remote-app')
		expect(manifest).toMatchObject({ appId: 'remote-app' })
	})

	it('rejects when the resolved manifest appId does not match the requested appId', async () => {
		stubManifestFetch({ appId: 'other-app', path: 'pages/index' })

		await expect(resolveManifestResourceBaseUrl('remote-app', 'https://cdn.example.com/manifests/app.json'))
			.rejects.toThrow('manifest appId other-app does not match remote-app')
		expect(sessionStorageStub.setItem).not.toHaveBeenCalled()
	})
})
