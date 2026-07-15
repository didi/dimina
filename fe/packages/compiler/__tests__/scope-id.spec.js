import { describe, expect, it } from 'vitest'
import { uuid } from '../src/common/utils.js'

// The per-module CSS scope id (`data-v-<id>`) is derived from the module path,
// not a random uuid. Determinism is load-bearing: the view stage, the style
// stage, and the render runtime each compute the scope independently, so a
// random id diverges across worker realms and breaks WXSS; a path hash keeps
// all three in lock-step and makes compiled output byte-stable / cacheable.
describe('uuid: deterministic per-path CSS scope id', () => {
  it('returns the same id for the same path across calls', () => {
    expect(uuid('pages/index/index')).toBe(uuid('pages/index/index'))
    expect(uuid('components/foo/foo')).toBe(uuid('components/foo/foo'))
  })

  it('is a stable hash, not random — pinned so the algorithm cannot drift silently', () => {
    expect(uuid('pages/index/index')).toBe('1ylz47sm9ljrt')
    expect(uuid('components/foo/foo')).toBe('1hdsyubayl3kv')
  })

  it('maps distinct paths to distinct ids', () => {
    expect(uuid('a')).not.toBe(uuid('b'))
    expect(uuid('pages/home/home')).not.toBe(uuid('pages/cart/cart'))
  })

  // Near-identical component paths (same length, differ by a few chars) are the
  // common case in mini-programs and exactly where a 32-bit crc32 collides —
  // these two share crc32 `9ys0y6`. A collision means two components share a
  // scope and cross-contaminate styles, so the hash must be wide enough to keep
  // them distinct; this pins that guarantee against a regression to a narrow hash.
  it('keeps near-identical component paths distinct (crc32 collided here)', () => {
    expect(uuid('/components/c16wtkpz/index')).not.toBe(
      uuid('/components/c1v8pxjl/index'),
    )
  })

  it('produces a base36 token usable verbatim in `data-v-<id>`', () => {
    const id = uuid('pages/detail/detail')
    expect(id).toMatch(/^[0-9a-z]+$/)
    expect(id.length).toBeGreaterThan(0)
  })
})
