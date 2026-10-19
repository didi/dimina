import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

test('QuickJS receives owned RGBA bytes and frame metadata without base64', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dimina-video-frame-'))
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const fixture = fileURLToPath(new URL('./fixtures/video-decoder-frame.cpp', import.meta.url))
  const sourcePatch = process.env.DIMINA_QUICKJS_PATCH ?? path.join(root, 'third_party/quickjs/patches/bridge-data.patch')
  try {
    if (process.env.DIMINA_VIDEO_FRAME_HEADER) {
      fs.copyFileSync(process.env.DIMINA_VIDEO_FRAME_HEADER, path.join(directory, 'video_decoder_frame.h'))
    }
    const source = fs.readFileSync(path.join(root, 'harmony/dimina/src/main/cpp/js_thread.cpp'), 'utf8')
    const register = source.match(/void registerFunc\(JSContext \*ctx,[\s\S]*?\n}/)?.[0]
    const construct = source.match(/JSEngine \*newEngine = new JSEngine\(appIndex,[\s\S]*?\n    }, debuggerAddress\);/)?.[0]
    assert.ok(register && construct, 'native registration code must be compiled by the fixture')
    fs.writeFileSync(path.join(directory, 'registration.h'), `
#include <functional>
struct JSEngine {
    std::function<void(JSContext *)> callback;
    JSEngine(int, std::function<void(JSContext *)> cb, const std::string &) : callback(cb) {}
};
void initBridges(JSContext *ctx, const char *, int owner) {
    JSValue global = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, global, "readFrame", CreateVideoDecoderFrameReader(ctx, owner));
    JS_SetPropertyStr(ctx, global, "seekForward", CreateVideoDecoderForwardSeeker(ctx, owner));
    JS_FreeValue(ctx, global);
}
void registerInvoke(JSContext *) {}
void registerPublish(JSContext *) {}
${register}
JSEngine *createEngine(int appIndex) {
    std::string virtualFilePrefix = "difile://", debuggerAddress;
    ${construct}
    return newEngine;
}
`)
    fs.writeFileSync(path.join(directory, 'CMakeLists.txt'), `
cmake_minimum_required(VERSION 3.22)
project(video_frame_test C CXX)
include("${root}/cmake/DiminaQuickJS.cmake")
add_executable(video_frame "${fixture}")
target_include_directories(video_frame PRIVATE "${directory}" "${root}/harmony/dimina/src/main/cpp")
target_compile_features(video_frame PRIVATE cxx_std_17)
dimina_configure_quickjs(video_frame ENABLE_DEBUGGER OFF SOURCE_PATCH "${sourcePatch}")
`)
    const cmake = process.env.CMAKE ?? 'cmake'
    const configure = spawnSync(cmake, ['-S', directory, '-B', path.join(directory, 'build'), '-DCMAKE_BUILD_TYPE=Release'], { encoding: 'utf8' })
    assert.equal(configure.status, 0, configure.error?.message || configure.stderr)
    const build = spawnSync(cmake, ['--build', path.join(directory, 'build'), '-j', '4'], { encoding: 'utf8' })
    assert.equal(build.status, 0, build.error?.message || build.stderr)
    const result = spawnSync(path.join(directory, 'build', 'video_frame'), [], { encoding: 'utf8', timeout: 10000 })
    assert.equal(result.status, 0, result.stderr)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
