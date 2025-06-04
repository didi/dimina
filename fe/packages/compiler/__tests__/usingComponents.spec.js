import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { storeInfo } from '../src/env.js'

// Mock fs module
vi.mock('node:fs', async (importOriginal) => {
	const actual = await importOriginal()
	return {
		...actual,
		default: {
			...actual.default,
			existsSync: vi.fn(),
			readFileSync: vi.fn(),
			mkdirSync: vi.fn(),
		},
		existsSync: vi.fn(),
		readFileSync: vi.fn(),
		mkdirSync: vi.fn(),
	}
})

describe('child component\'s usingComponents', () => {
  const mockWorkPath = path.join(os.tmpdir(), 'dimina-test-project')
	const originalEnv = { ...process.env }

	beforeEach(() => {
		vi.clearAllMocks()

		const { existsSync, readFileSync } = fs.default || fs

    const mockFiles = [
      {
        name: 'app.json',
        content: JSON.stringify({
          pages: ['pages/index/index'],
        })
      },
      {
        name: 'pages/index/index.json',
        content: JSON.stringify({
          usingComponents: {
            'custom-button': '../../components/custom-button/index',
          }
        })
      },
      {
        name: 'components/custom-button/index.json',
        content: JSON.stringify({
          component: true,
          usingComponents: {
            'custom-icon': '../custom-icon/index',
          }
        })
      },
      {
        name: 'components/custom-icon/index.json',
        content: JSON.stringify({
          component: true,
        })
      }
    ]

    existsSync.mockImplementation((filePath) => {
      return mockFiles.some(file => filePath.endsWith(file.name))
    })

    readFileSync.mockImplementation((filePath) => {
      const file = mockFiles.find(file => filePath.endsWith(file.name))
      return file ? file.content : '{}'
    })
	})

	afterEach(() => {
		process.env = { ...originalEnv }
	})

	it('should collect usingComponents from child components', () => {
    const { configInfo } = storeInfo(mockWorkPath)
    
    Object.keys(configInfo.componentInfo).forEach(id => {
      const { usingComponents } = configInfo.componentInfo[id]

      Object.keys(usingComponents).forEach(name => {
        const path= usingComponents[name]
        expect(path).toMatch(/^\/components\//)
      })
    })
	})
})