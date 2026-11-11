import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { wxsStandardCases, wxsVocabularyCases } from '../packages/compiler/__tests__/fixtures/wxs-standard-library.js'

const executable = process.argv[2] || '/Applications/wechatwebdevtools.app/Contents/Resources/app.asar.unpacked/node_modules/wcc-exec/wcc'
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dimina-wxs-contract-'))
function run(source, files = {}) {
	fs.writeFileSync(path.join(root, 'index.wxml'), `<wxs module="u">${source}</wxs><view>{{u.run()}}</view>`)
	for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(root, name), content)
	const output = execFileSync(executable, ['index.wxml', ...Object.keys(files)], { cwd: root, encoding: 'utf8', timeout: 5000 })
	const context = vm.createContext({ window: {}, console: { log() {}, warn() {}, error() {} } })
	vm.runInContext(output, context, { timeout: 1000 })
	const tree = vm.runInContext('$gwx("index.wxml")({}, {}, {})', context, { timeout: 1000 })
	const text = node => typeof node === 'string' ? node : (node?.children || []).map(text).join('')
	return text(tree)
}
try {
	const cases = [...wxsStandardCases, ...wxsVocabularyCases].map(([name, body, expected]) => [name, `module.exports.run=function(){${body}}`, String(expected)])
	cases.push(['shared module scope', 'var a=require("./counter.wxs");var b=require("./counter.wxs");module.exports.run=function(){return a.next()+"|"+b.next()+"|"+(a===b)}', '1|2|true', { 'counter.wxs': 'var n=0;module.exports.next=function(){return ++n}' }])
	let failed = 0
	for (const [name, source, expected, files] of cases) {
		const actual = run(source, files)
		if (actual !== expected) {
			failed++
			console.error(`${name}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`)
		}
	}
	console.log(`WXS contracts: ${cases.length - failed}/${cases.length} passed`)
	if (failed) process.exitCode = 1
}
finally { fs.rmSync(root, { recursive: true, force: true }) }
