import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/api/common', () => ({
	invokeAPI: vi.fn(() => 'bridge-result'),
}))

import { invokeAPI } from '@/api/common'
import { chooseMessageFile } from '@/api/core/media/image/index.js'

describe('wx.chooseMessageFile', () => {
	beforeEach(() => {
		vi.mocked(invokeAPI).mockClear()
	})

	it('forwards the complete official option object to the native bridge', () => {
		const options = {
			count: 3,
			type: 'file',
			extension: ['pdf', 'docx'],
			success: vi.fn(),
			fail: vi.fn(),
			complete: vi.fn(),
		}

		expect(chooseMessageFile(options)).toBe('bridge-result')
		expect(invokeAPI).toHaveBeenCalledOnce()
		expect(invokeAPI).toHaveBeenCalledWith('chooseMessageFile', options)
	})
})
