import { expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { execFileSync } from 'node:child_process'
import ts from 'typescript'

it('installs local Harmony packages, rolls back failed same-version publication and preserves user data', async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dimina-local-package-'))
	try {
		let failPublish = false
		const appDir = (id: string) => path.join(root, 'apps', id)
		const configPath = (id: string) => path.join(appDir(id), 'config.json')
		const fileManager = {
			getJSAppDir: appDir, getJSAppConfigPath: configPath,
			getJSAppVersionDir: (id: string, version: string) => path.join(appDir(id), version),
			loadJSAppConfig: (id: string) => {
				if (!fs.existsSync(configPath(id))) return null
				const data = JSON.parse(fs.readFileSync(configPath(id), 'utf8'))
				return { getNumber: (key: string) => data[key] }
			},
			writeJsonToFile: (file: string, data: string) => { fs.writeFileSync(file, data); return true },
		}
		const nativeFS = {
			accessSync: fs.existsSync, statSync: fs.statSync, readTextSync: (p: string) => fs.readFileSync(p, 'utf8'),
			mkdirSync: (p: string, recursive = false) => fs.mkdirSync(p, { recursive }),
			rmdirSync: (p: string) => fs.rmSync(p, { recursive: true }), unlinkSync: fs.unlinkSync,
			renameSync: fs.renameSync,
			moveFileSync: (src: string, dest: string) => {
				if (failPublish && src.includes('.tmp-')) throw new Error('publish failed')
				fs.renameSync(src, dest)
			},
		}
		const imports: Record<string, any> = {
			'@ohos.file.fs': { __esModule: true, default: nativeFS }, '@ohos.security.cryptoFramework': {},
			'@kit.NetworkKit': {}, '@kit.BasicServicesKit': {}, '../DApp/DMPApp': {},
			'./Util/DMPFileManager': { DMPFileManager: { sharedInstance: () => fileManager } },
			'./Util/DMPUnzipManager': { DMPUnzipManager: { unzipFileAtPathAsync: async (zip: string, dest: string) => {
				execFileSync('/usr/bin/unzip', ['-q', zip, '-d', dest]); return true
			} } },
			'../Utils/DMPContextUtils': {}, '../EventTrack/DMPLogger': {}, '../EventTrack/Tags': {},
		}
		const source = fs.readFileSync(path.resolve(import.meta.dirname, '../../../../harmony/dimina/src/main/ets/Bundle/DMPRemoteUpdateManager.ets'), 'utf8')
		const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
		const exports: any = {}
		vm.runInNewContext(code, { exports, require: (name: string) => {
			if (!(name in imports)) throw new Error(`Unmocked import ${name}`)
			return imports[name]
		}, Map, Set, Promise, Error, Date, Number, JSON })
		const manager = exports.DMPRemoteUpdateManager.sharedInstance()
		const id = 'local-test'
		function archive(version: number, content: string, valid = true, appId = id, directoryLogic = false) {
			const dir = fs.mkdtempSync(path.join(root, 'source-'))
			fs.mkdirSync(path.join(dir, 'main'))
			fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ appId, name: 'test', path: 'pages/index', versionCode: version, versionName: `v${version}` }))
			fs.writeFileSync(path.join(dir, 'main/app-config.json'), '{}')
			if (directoryLogic) fs.mkdirSync(path.join(dir, 'main/logic.js'))
			else if (valid) fs.writeFileSync(path.join(dir, 'main/logic.js'), content)
			const zip = dir + '.zip'
			execFileSync('/usr/bin/zip', ['-qr', zip, '.'], { cwd: dir })
			return zip
		}
		expect(manager.getAppVersionInfo(id)).toBeUndefined()
		const zip = archive(2, 'original')
		await manager.installLocalPackage(id, zip)
		expect(fs.existsSync(zip)).toBe(true)
		const user = path.join(appDir(id), 'resource/store/keep')
		fs.mkdirSync(path.dirname(user), { recursive: true }); fs.writeFileSync(user, 'user')
		for (const invalid of [archive(3, '', false), archive(3, '', true, 'other-app'), archive(3, '', true, id, true)]) {
			await expect(manager.installLocalPackage(id, invalid)).rejects.toThrow()
			expect(manager.getAppVersionInfo(id).versionCode).toBe(2)
		}
		failPublish = true
		await expect(manager.installLocalPackage(id, archive(2, 'replacement'))).rejects.toThrow('publish failed')
		expect(fs.readFileSync(path.join(appDir(id), '2/main/logic.js'), 'utf8')).toBe('original')
		expect(manager.getAppVersionInfo(id).versionCode).toBe(2)
		failPublish = false
		await manager.installLocalPackage(id, archive(2, 'replacement'))
		expect(fs.readFileSync(path.join(appDir(id), '2/main/logic.js'), 'utf8')).toBe('replacement')
		fs.mkdirSync(path.join(appDir(id), '.pending')); fs.writeFileSync(path.join(appDir(id), '.pending/config.json'), '{}')
		await manager.installLocalPackage(id, archive(1, 'downgrade'))
		expect(manager.getAppVersionInfo(id).versionCode).toBe(1)
		expect(manager.getAppVersionInfo(id).hostManaged).toBe(true)
		expect(fs.existsSync(path.join(appDir(id), '.pending'))).toBe(false)
		expect(fs.readFileSync(user, 'utf8')).toBe('user')
	} finally { fs.rmSync(root, { recursive: true, force: true }) }
})
