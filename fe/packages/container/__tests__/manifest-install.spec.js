import { afterEach, describe, expect, it, vi } from 'vitest'
import { getMiniAppManifest } from '../src/services'

describe('ManifestUrl installation', () => {
	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it('resolves an enveloped manifest and its relative web base URL', async () => {
		vi.stubGlobal('window', {
			location: { href: 'https://container.example.com/index.html' },
		})
		vi.stubGlobal('fetch', vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({
				data: {
					appId: 'remote-app',
					name: 'Remote App',
					path: 'pages/index',
					webBaseUrl: './published/',
				},
			}),
		})))

		const manifest = await getMiniAppManifest('https://cdn.example.com/manifests/app.json')

		expect(manifest).toMatchObject({
			appId: 'remote-app',
			name: 'Remote App',
			path: 'pages/index',
			manifestUrl: 'https://cdn.example.com/manifests/app.json',
			resourceBaseUrl: 'https://cdn.example.com/manifests/published/',
		})
	})

	it('rejects a manifest without an appId', async () => {
		vi.stubGlobal('window', {
			location: { href: 'https://container.example.com/index.html' },
		})
		vi.stubGlobal('fetch', vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({ path: 'pages/index' }),
		})))

		await expect(getMiniAppManifest('/app.json')).rejects.toThrow('manifest missing appId')
	})
})
