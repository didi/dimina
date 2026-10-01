function assert(value, message) { if (!value) throw new Error(message) }
globalThis.__teardownBuffers = []
for (const [label, bytes] of [['plain', __hostMemoryBytes], ['aux globals', __hostMemoryAuxBytes]]) {
    const module = new WXWebAssembly.Module(new Uint8Array(bytes))
    const first = new WXWebAssembly.Instance(module).exports
    const second = new WXWebAssembly.Instance(module).exports
    const memory = first.memory
    const initial = memory.buffer
    assert(initial.byteLength === 65536, `${label}: exported initial memory retains a full Wasm page`)
    first.write(4, 123456)
    new Int32Array(initial)[2] = 987654
    assert(first.read(4) === 123456 && first.read(8) === 987654, `${label}: live reads and writes`)
    assert(memory.grow(1) === 1, `${label}: host grow works without a memory.grow opcode`)
    assert(initial.byteLength === 0, `${label}: host grow detaches the previous buffer`)
    const grown = memory.buffer
    assert(grown.byteLength === 131072 && first.read(8) === 987654, `${label}: host grow retains contents`)
    assert(first.read(65536) === 0, `${label}: new memory page is zero initialized`)
    first.write(65536, 77)
    assert(new Int32Array(grown)[16384] === 77, `${label}: new memory page is live`)
    let failed = false
    try { memory.grow(3) } catch (error) { failed = error instanceof RangeError }
    assert(failed && memory.buffer === grown && grown.byteLength === 131072 && first.read(65536) === 77,
        `${label}: failed growth preserves the buffer and its contents`)
    assert(memory.grow(2) === 2 && grown.byteLength === 0, `${label}: can grow to the declared four-page maximum`)
    const maximum = memory.buffer
    assert(maximum.byteLength === 262144 && first.read(65536) === 77, `${label}: maximum size and retained contents`)
    failed = false
    try { memory.grow(1) } catch (error) { failed = error instanceof RangeError }
    assert(failed && memory.buffer === maximum && maximum.byteLength === 262144, `${label}: maximum is enforced`)
    assert(memory.grow(0) === 4 && maximum.byteLength === 0, `${label}: zero growth still detaches the old buffer`)
    assert(second.memory.buffer.byteLength === 65536 && second.read(4) === 0, `${label}: another instance retains its own memory`)
    globalThis.__teardownBuffers.push(memory.buffer, second.memory.buffer)
}
