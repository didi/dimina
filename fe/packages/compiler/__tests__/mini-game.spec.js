import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import build from '../src/index.js'
import { getRuntimeType, storeInfo } from '../src/env.js'

describe('mini game compiler entry', () => {
	let projectDir
	let outputDir

	beforeEach(() => {
		projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dimina-mini-game-'))
		outputDir = path.join(projectDir, 'dist')
	})

	afterEach(() => {
		fs.rmSync(projectDir, { recursive: true, force: true })
	})

	function write(relativePath, content) {
		const filePath = path.join(projectDir, relativePath)
		fs.mkdirSync(path.dirname(filePath), { recursive: true })
		fs.writeFileSync(filePath, content)
	}

	it('detects game.js/game.json, emits one logic entry, and skips page assets', async () => {
		write('project.config.json', JSON.stringify({ appid: 'mini-game-app', compileType: 'game' }))
		write('game.json', JSON.stringify({ deviceOrientation: 'landscape' }))
		write('game.js', "const score = require('./score')\nglobalThis.result = score + 1\n")
		write('score.js', 'module.exports = 41\n')

		await build(outputDir, projectDir, false)

		const config = JSON.parse(fs.readFileSync(path.join(outputDir, 'main/app-config.json'), 'utf8'))
		const logic = fs.readFileSync(path.join(outputDir, 'main/logic.js'), 'utf8')
		expect(config.app).toMatchObject({
			runtimeType: 'game',
			entryPagePath: 'game',
			pages: ['game'],
			deviceOrientation: 'landscape',
			window: { navigationStyle: 'custom' },
		})
		expect(config.modules).toEqual({})
		expect(logic).toContain('modDefine("game"')
		expect(logic).toContain('modDefine("/score"')
		expect(fs.existsSync(path.join(outputDir, 'main/game.js'))).toBe(false)
		expect(fs.existsSync(path.join(outputDir, 'main/game.css'))).toBe(false)
	})

	it('falls back to the game entry when project.config.json omits compileType', () => {
		write('project.config.json', JSON.stringify({ appid: 'mini-game-auto' }))
		write('game.json', '{}')
		write('game.js', '')

		storeInfo(projectDir)
		expect(getRuntimeType()).toBe('game')
	})
})
