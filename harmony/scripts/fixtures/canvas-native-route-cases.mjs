import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { Worker } from 'node:worker_threads'
import { CanvasBinaryPort } from '../../../fe/packages/render/src/core/canvas-binary-port.js'
const addonPath = process.env.DIMINA_CANVAS_ADDON
const native = createRequire(import.meta.url)(addonPath)
const tick = () => new Promise(resolve => setImmediate(resolve))
async function until(predicate) { const end = Date.now() + 2000; while (!predicate()) { assert.ok(Date.now() < end, 'condition did not become true'); await tick() } }
const feedback = '{"contexts":{"gl":{"created":false}},"typedArrays":[]}'

async function dispose(token) { native.unregister(9, 3, token); await tick() }

test('actual N-API preserves legacy three-argument registration and ordered replies', async () => {
	const order = []
	const token = native.register(9, 3, (id, script) => { order.push(script); if (id) native.complete(id, feedback, '') })
	try {
		assert.equal(native.publish(9, 3, 'before'), true)
		assert.equal(await native.query(9, 3, '{}'), feedback)
		assert.equal(native.publish(9, 3, 'after'), true)
		await until(() => order.length === 3)
		assert.equal(order[0], 'before'); assert.match(order[1], /__diminaCanvasSync/); assert.equal(order[2], 'after')
		assert.equal(native.ready(9, 3, token), false)
	} finally { await dispose(token) }
})

test('unacknowledged startup drains the original FIFO to real TSFN callbacks and rejects late readiness', async () => {
	const order = []
	const token = native.register(9, 3, (id, script) => { order.push(script); if (id) native.complete(id, feedback, '') }, 'web3')
	try {
		native.publish(9, 3, 'before')
		const pending = native.query(9, 3, '{}')
		await until(() => native.pending(9, 3) === 1)
		native.publish(9, 3, 'after')
		assert.equal(native.connect(9, 3, token), true)
		assert.equal(native.messages().length, 0)
		assert.equal(native.connect(9, 3, token, false), true)
		assert.equal(await pending, feedback)
		await until(() => order.length === 3)
		assert.equal(order[0], 'before'); assert.match(order[1], /__diminaCanvasSync/); assert.equal(order[2], 'after')
		native.feedback('ready\n' + token)
		assert.equal(native.ready(9, 3, token), false)
		assert.equal(native.messages().length, 0)
	} finally { await dispose(token) }
})

test('production C++ packets deliver async bytes before a real renderer reply through non-UI feedback', async () => {
	let bytes, calls = []
	const token = native.register(9, 3, () => { assert.fail('live native port must not use TSFN') }, 'web3')
	const result = { contexts: { gl: { resources: [{ resourceId: 'buffer', metadata: { created: false } }], queries: [{ key: 'pixel', value: 0 }] } }, typedArrays: [] }
	try {
		native.connect(9, 3, token); native.feedback('ready\n' + token)
		assert.equal(native.ready(9, 3, token), true)
		native.publish(9, 3, 'before')
		const source = new Uint8Array([0, 255, 128, 17])
		assert.equal(native.publishBody(9, 3, '{"pixels":{"__canvasBinaryIndex":0}}', source.buffer), true)
		source.fill(33)
		const query = native.query(9, 3, '{"read":"pixel"}')
		await until(() => native.pending(9, 3) === 1)
		native.publish(9, 3, 'after')
		const window = { eval: script => script === 'true' ? true : calls.push(script), addEventListener() {}, removeEventListener() {},
			DiminaRenderBridge: { onMessage: body => { bytes = Uint8Array.from(body.pixels); calls.push('publish') } } }
		const renderer = new CanvasBinaryPort(window, body => { assert.deepEqual(body, { read: 'pixel' }); calls.push('query'); result.contexts.gl.queries[0].value = bytes[0]; return result })
		renderer.connect(token)
		renderer.accept({ data: token, ports: [{ start() {}, close() {}, postMessage: text => native.feedback(text) }] })
		for (const message of native.messages()) renderer.receive(message)
		assert.deepEqual([...bytes], [0, 255, 128, 17])
		assert.deepEqual(calls, ['before', 'publish', 'query', 'after'])
		assert.deepEqual(JSON.parse(await query), result)
		const before = native.stats().closes
		assert.equal(native.connect(9, 3, token, false), true)
		assert.equal(native.ready(9, 3, token), true)
		assert.equal(native.stats().closes, before, 'never fall back or replay after actual binary activation')
	} finally { await dispose(token) }
})

test('fatal feedback owns its error text, cancels waiting queries and closes ports on UI', async () => {
	const before = native.stats().destroyed
	const token = native.register(9, 3, () => {}, 'web3')
	native.connect(9, 3, token); native.feedback('ready\n' + token)
	const pending = native.query(9, 3, '{}')
	await until(() => native.pending(9, 3) === 1)
	const rejected = assert.rejects(pending, value => value === 'actual renderer failure')
	native.feedback('error\n' + token + '\nactual renderer failure')
	await rejected
	await until(() => native.stats().destroyed > before)
	await dispose(token)
	// This uses the retired native callback and pointer, not a live port handle.
	native.feedback('malformed late feedback')
})

test('absent and truncated APIs plus failed port transfer select working legacy callbacks', async () => {
	for (const options of [[0, 0, 0], [2, 0, 0], [1, 1, 0]]) {
		native.options(...options)
		const token = native.register(9, 3, (id) => { if (id) native.complete(id, feedback, '') }, 'web3')
		try {
			assert.equal(native.connect(9, 3, token), true)
			assert.equal(native.ready(9, 3, token), false)
			assert.equal(await native.query(9, 3, '{}'), feedback)
		} finally { await dispose(token); native.options(1, 0, 0) }
	}
})

test('actual Node environments cannot replace, complete or close another UI owner', async () => {
	let requestId
	const token = native.register(9, 3, id => { requestId = id })
	const pending = native.query(9, 3, '{}')
	await until(() => !!requestId)
	const worker = new Worker(`
		const { parentPort, workerData } = require('node:worker_threads');const n = require(workerData.path);
		let replacement=false;try { n.register(9,3,()=>{},'foreign-ui');replacement=true } catch (_) {}
		n.unregister(9,3,workerData.token);n.complete(workerData.id,'wrong environment','');
		const published=n.publish(9,3,'wrong environment');n.register(19,3,()=>{});
		parentPort.postMessage({replacement,published});
	`, { eval: true, workerData: { path: addonPath, token, id: requestId } })
	try {
		const result = await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject) })
		assert.deepEqual(result, { replacement: false, published: false })
		native.complete(requestId, feedback, '')
		assert.equal(await pending, feedback)
		await worker.terminate()
		await assert.rejects(native.query(19, 3, '{}'), value => value === 'channel unavailable')
	} finally { await worker.terminate(); await dispose(token) }
})


test('a retired callback cannot close a new page when the native port address is reused', async () => {
  native.options(3, 0, 0)
  let first = native.register(9, 3, () => {}, 'same-tag')
  native.connect(9, 3, first); native.feedback('ready\n' + first); native.remember()
  const oldDestroyed = native.stats().destroyed
  await dispose(first); await until(() => native.stats().destroyed > oldDestroyed)
  const next = native.register(9, 3, () => {}, 'same-tag')
  try {
    native.connect(9, 3, next); native.feedback('ready\n' + next)
    native.feedback('malformed late packet', 1)
    assert.equal(native.ready(9, 3, next), true)
    native.feedback('error\n' + first + '\nold page failed', 1)
    assert.equal(native.ready(9, 3, next), true)
  } finally { await dispose(next); native.options(1, 0, 0) }
})


test('a live post failure rejects the real query and never replays through TSFN', async () => {
  let callbacks = 0
  const token = native.register(9, 3, () => { callbacks++ }, 'web3')
  native.connect(9, 3, token); native.feedback('ready\n' + token); native.messages()
  native.options(1, 0, 1)
  try {
    await assert.rejects(native.query(9, 3, '{}'), value => value === 'canvas UI submission failed')
    assert.equal(callbacks, 0); assert.equal(native.messages().length, 0)
    assert.equal(native.connect(9, 3, token, false), false)
  } finally { await dispose(token); native.options(1, 0, 0) }
})

test('an unacknowledged port bounds queued scripts and cancels instead of replaying them', async () => {
  let callbacks = 0
  const token = native.register(9, 3, () => { callbacks++ }, 'web3')
  try {
    for (let i = 0; i < 200; i++) assert.equal(native.publish(9, 3, 'queued-' + i), true)
    assert.equal(native.publish(9, 3, 'overflow'), false)
    assert.equal(native.publish(9, 3, 'late'), false)
    assert.equal(callbacks, 0); assert.equal(native.messages().length, 0)
  } finally { await dispose(token) }
})
