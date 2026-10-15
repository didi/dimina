import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dimina-video-seek-'))
const executable = path.join(directory, 'video-decoder-seek')
const input = path.join(directory, 'video.mock')

before(() => {
  const native = fileURLToPath(new URL('../dimina/src/main/cpp/', import.meta.url))
  const sourcePath = process.env.DIMINA_VIDEO_DECODER_SOURCE ?? path.join(native, 'video_decoder.cpp')
  const source = fs.readFileSync(sourcePath, 'utf8')
  const start = source.indexOf('\nnamespace {')
  const end = source.indexOf('\nusing Key =', start)
  assert.ok(start >= 0 && end > start, 'compile the real production Decoder class')
  const decoder = source.slice(start, end).replace(/\nprivate:\n/g, '\npublic:\n')
  fs.writeFileSync(path.join(directory, 'production-decoder.h'), `${decoder}\n}\n`)
  fs.writeFileSync(input, Buffer.alloc(64))
  const fixture = fileURLToPath(new URL('./fixtures/video-decoder-seek.cpp', import.meta.url))
  const compile = spawnSync(process.env.CXX ?? 'c++', [
    '-std=c++17', '-O2', '-pthread', '-Wall', '-Wextra', '-Werror', '-I', native, '-I', directory,
    fixture, '-o', executable,
  ], { encoding: 'utf8', timeout: 30000 })
  assert.equal(compile.status, 0, compile.error?.message || compile.stderr)
})

after(() => fs.rmSync(directory, { recursive: true, force: true }))

const cases = [
  ['select-small', '16x16 video selects software when the recommended hardware starts at 64x64'],
  ['select-hardware', 'normal video keeps the supported hardware decoder'],
  ['select-pixel-format', 'a decoder without NV12 output is replaced by a capable software decoder'],
  ['select-recommended-missing', 'missing system recommendation still finds a supported hardware decoder'],
  ['select-software-missing', 'unsupported dimensions report a capability error before creating a driver instance'],
  ['select-software-incompatible', 'software without required NV12 output cannot claim video support'],
  ['direct-forward', 'direct forward seek advances the live pump and preserves exact post-target PTS'],
  ['direct-pending', 'direct seek cannot bypass queued native control work'],
  ['direct-busy', 'direct seek falls back without waiting for an active control operation'],
  ['direct-removed', 'direct seek cannot revive a removed decoder'],
  ['direct-eos', 'direct seek leaves exhausted decoder recovery asynchronous'],
  ['direct-same', 'direct seek never fabricates a seek back to a delivered frame'],
  ['headers', 'real PAG AVCC and AnnexB headers are bounded and never cache ordinary IDR/frame bytes'],
  ['flush-backward', 'trusted CSD reuses a backward-seek codec via Flush then Start without Configure/Prepare'],
  ['flush-eos', 'input/output EOS restarts the same codec with fresh CSD and exact subsequent PTS'],
  ['flush-owned', 'parameter storage is owned independently of track-format memory'],
  ['flush-inband', 'a SYNC_FRAME-only SPS/PPS+IDR sample caches only headers while retaining original sample PTS/data'],
  ['flush-indices', 'Flush callback barrier invalidates all old input/output indices before restarting'],
  ['flush-no-headers', 'missing parameter sets retain the original decoder rebuild path'],
  ['flush-bad-headers', 'malformed parameter sets retain the original decoder rebuild path'],
  ['flush-failure', 'Flush failure safely falls back to the original decoder rebuild path'],
  ['flush-start-failure', 'Start failure after Flush safely falls back to original decoder rebuild'],
  ['flush-cancel', 'stop cancellation during the Flush barrier never restarts a codec or pump'],
  ['flush-removed', 'remove cancellation during the Flush barrier never restarts a codec or pump'],
  ['fast-preserve', 'forward seek reuses the codec and retains converted frames at or above target'],
  ['target-first', 'forward seek returns the first frame at or above the new target'],
  ['inflight-below', 'forward seek returns without joining and rejects an in-flight conversion below its new target'],
  ['inflight-above', 'forward seek returns without joining and retains an in-flight conversion at or above its new target'],
  ['callbacks', 'running forward seek retains callback buffers and the same pump without pool loss'],
  ['same-frame', 'seeking to the last delivered frame rebuilds the codec'],
  ['backward', 'backward seek rebuilds the codec'],
  ['undelivered', 'seek before any delivered frame rebuilds the codec'],
  ['output-eos', 'output EOS forces rebuilding rather than reusing an exhausted codec'],
  ['input-eos', 'input EOS forces rebuilding rather than reusing an exhausted codec'],
  ['nested-target', 'a smaller second target rebuilds even when it exceeds the last delivered frame'],
  ['cancel', 'stop cancellation during a paused join cannot resume or commit a frame'],
  ['removed', 'removal during a paused join cannot resume or commit a frame'],
  ['clock', 'mode zero resets the playback clock after a forward seek'],
  ['error-before', 'an existing codec error uses the original rebuild recovery path'],
  ['error-during', 'a codec error during pause rebuilds and invalidates old buffers'],
  ['rebuild-failure', 'a failed rebuild stops the codec and leaves no pump or frames'],
  ['invalid-position', 'invalid seek positions reject without tearing down an active decoder'],
  ['stale-generation', 'a stale seek generation rejects without clearing an active decoder or queued frames'],
]

for (const [name, description] of cases) {
  test(description, () => {
    const result = spawnSync(executable, [name, input], { encoding: 'utf8', timeout: 15000 })
    assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout)
  })
}
