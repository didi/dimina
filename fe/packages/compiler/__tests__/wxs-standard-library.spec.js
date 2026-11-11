import vm from 'node:vm'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { processWxsContent } from '../src/core/view-compiler.js'
import { wxsStandardCases, wxsVocabularyCases } from './fixtures/wxs-standard-library.js'

function evaluate(body, options = {}) {
	const modules = []
	const source = processWxsContent(options.source || ('module.exports.run=function(){' + body + '}'), options.file || null, modules, options.root || '', '')
	const cache = new Map()
	const require = id => {
		if (!cache.has(id)) {
			const module = { exports: {} }
			cache.set(id, module)
			vm.runInNewContext(modules.find(item => item.path === id).code, { module, exports: module.exports, require })
		}
		return cache.get(id).exports
	}
	const module = { exports: {} }
	vm.runInNewContext(source, { module, exports: module.exports, require })
	return { value: module.exports.run(), modules }
}

describe('bundled wcc WXS standard library contracts', () => {
	it.each([...wxsStandardCases, ...wxsVocabularyCases])('%s', (name, body, expected) => {
		expect(evaluate(body).value).toEqual(expected)
	})
	it('shares external module state and emits the standard library once', () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dimina-wxs-shared-'))
		try {
			fs.writeFileSync(path.join(root, 'counter.wxs'), 'var n=0;module.exports.next=function(){return ++n}')
			const { value, modules } = evaluate('', {
				root, file: path.join(root, 'index.wxs'),
				source: 'var a=require("./counter.wxs");var b=require("./counter.wxs");module.exports.run=function(){return a.next()+"|"+b.next()+"|"+(a===b)}',
			})
			expect(value).toBe('1|2|true')
			expect(modules.filter(item => item.path === 'dimina:wxs-runtime')).toHaveLength(1)
			expect(modules.filter(item => item.path === 'counter')).toHaveLength(1)
		}
		finally { fs.rmSync(root, { recursive: true, force: true }) }
	})
	it('preserves null and undefined member errors', () => {
		expect(() => evaluate('return null.x')).toThrow()
		expect(() => evaluate('return undefined.x')).toThrow()
	})
	it('keeps lexical helper names and module loader bindings local', () => {
		expect(evaluate('var __diminaWxs=3;var require=function(){return 4};return __diminaWxs+require("unused")').value).toBe(7)
	})
})
