import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { collectAssets, isCollectableImageAsset } from '../src/common/utils.js'

it('does not collect host image URLs as package assets, even with an image extension', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'host-image-assets-'))
	const log = vi.spyOn(console, 'log').mockImplementation(() => {})
	try {
		for (const src of ['dimina-image://light', 'dimina-image://icons/nested/light.png', 'dimina-image://icons/a.svg?v=2']) {
			expect(isCollectableImageAsset(src)).toBe(false)
			expect(collectAssets(root, 'pages/index.wxml', src, path.join(root, 'dist'), 'app')).toBe(src)
		}
		expect(log).not.toHaveBeenCalled()
		expect(fs.existsSync(path.join(root, 'dist'))).toBe(false)
		expect(isCollectableImageAsset('/images/local.png')).toBe(true)
	} finally { log.mockRestore(); fs.rmSync(root, { recursive: true, force: true }) }
})
