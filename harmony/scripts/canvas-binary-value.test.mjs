import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { CanvasBinaryPort } from '../../fe/packages/render/src/core/canvas-binary-port.js'

test('actual QuickJS publish preserves packed bytes, JSON semantics, lifetimes and browser framing', () => {
	const output = mkdtempSync(join(tmpdir(), 'dimina-canvas-value-'))
	const root = fileURLToPath(new URL('../../', import.meta.url))
	try {
		const source = readFileSync(join(root, 'harmony/dimina/src/main/cpp/js_thread.cpp'), 'utf8')
		const begin = source.indexOf('static JSValue publish('), end = source.indexOf('\n}\n', begin) + 3
		assert.ok(begin >= 0 && end > begin, 'the fixture must compile the production publish function')
		const utils = readFileSync(join(root, 'harmony/dimina/src/main/cpp/utils.cpp'), 'utf8')
		const first = utils.indexOf('char *JSValueToString('), last = utils.indexOf('\n}\n', first) + 3
		assert.ok(first >= 0 && last > first)
		const encoderStart = source.indexOf('static JSValue js_encode_canvas_array_buffer(')
		const encoderEnd = source.indexOf('\n}\n', encoderStart) + 3
		assert.ok(encoderStart >= 0 && encoderEnd > encoderStart)
		writeFileSync(join(output, 'publish-under-test.h'), utils.slice(first, last) + '\n' +
			source.slice(begin, end) + '\n' + source.slice(encoderStart, encoderEnd))
		writeFileSync(join(output, 'CMakeLists.txt'), `
cmake_minimum_required(VERSION 3.22)
project(canvas_binary_test C CXX)
include("${root}/cmake/DiminaQuickJS.cmake")
add_executable(canvas_value "${root}/harmony/scripts/fixtures/canvas-binary-value.cpp")
target_include_directories(canvas_value PRIVATE "${root}/harmony/dimina/src/main/cpp" "${output}")
target_compile_features(canvas_value PRIVATE cxx_std_17)
target_compile_options(canvas_value PRIVATE -UNDEBUG)
dimina_configure_quickjs(canvas_value ENABLE_DEBUGGER OFF SOURCE_PATCH "${root}/third_party/quickjs/patches/bridge-data.patch")
`)
		const cmake = process.env.CMAKE ?? 'cmake'
		for (const args of [['-S', output, '-B', join(output, 'build'), '-DCMAKE_BUILD_TYPE=Debug'], ['--build', join(output, 'build'), '-j', '4']]) {
			const build = spawnSync(cmake, args, { encoding: 'utf8' })
			assert.equal(build.status, 0, build.stderr || build.error?.message)
		}
		const packet = join(output, 'publish.packet')
		const result = spawnSync(join(output, 'build/canvas_value'), [packet], { encoding: 'utf8', timeout: 10000 })
		assert.equal(result.status, 0, result.stdout + result.stderr)
		assert.match(result.stdout, /PASS/)
		let message
		const channel = new CanvasBinaryPort({ eval: () => true, addEventListener() {}, removeEventListener() {},
			DiminaRenderBridge: { onMessage: value => { message = value } } }, () => { assert.fail('async publication must use its actual message entry') })
		assert.equal(channel.connect('page'), true)
		const replies = []
		channel.accept({ data: 'page', ports: [{ start() {}, close() {}, postMessage: text => replies.push(text) }] })
		channel.receive(Uint8Array.from(readFileSync(packet)).buffer)
		assert.ok(message, replies.join('\n'))
		const expected = Buffer.alloc(131072)
		for (let index = 0; index < expected.length; index++) expected[index] = index % 251
		assert.ok(Buffer.from(message.body.frame.packed).equals(expected))
		assert.equal(message.body.empty.packed.byteLength, 0)
		assert.equal(message.body.text, '\uD800\u0000画布')
		assert.equal(message.body.when, '1970-01-01T00:00:00.000Z')
		channel.disconnect('page')
	} finally { rmSync(output, { recursive: true, force: true }) }
})
