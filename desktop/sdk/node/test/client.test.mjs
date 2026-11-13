import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Dimina } from '../index.js'

async function fixture(t, mode = 'normal') {
  const dir = await mkdtemp(join(tmpdir(), 'dimina sdk '))
  const runtimePath = join(dir, 'runtime')
  const source = `#!/usr/bin/env node
import http from 'node:http';
import {writeFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
writeFileSync(${JSON.stringify(join(dir, 'pid'))},String(process.pid));
const mode=${JSON.stringify(mode)};
if(mode==='hang'){process.stdin.resume();}else{
const windows=new Map();let next=0;
const responses=new Map();
createInterface({input:process.stdin}).on('line',line=>{const reply=JSON.parse(line);responses.get(reply.id)?.(reply);responses.delete(reply.id);});
const server=http.createServer(async(req,res)=>{
 if(req.headers.authorization!=='Bearer '+ 'f'.repeat(48)){res.writeHead(401);res.end();return;}
 let raw='';for await(const chunk of req)raw+=chunk;
 const body=raw?JSON.parse(raw):{};const method=req.url.split('/').at(-1);let value=null;
 if(mode==='stall-close'&&method==='closeAll')return;
 if(method==='open'){
  if(body.appId==='broken'){res.writeHead(400);res.end(JSON.stringify({error:'startup failed'}));return;}
  value=[...windows.values()].find(w=>w.appId===body.appId);
  if(!value){value={id:String(++next),appId:body.appId,name:body.name||body.appId,ready:true};windows.set(value.id,value);}
  if(mode==='native'){
   const id='call-'+next;
   const pending=new Promise(resolve=>responses.set(id,resolve));
   const call={type:'native-call',id,windowId:value.id,appId:body.appId,name:body.appId.startsWith('cancel')?'openSetting':'getNetworkType',params:{message:'你好'}};
   if(body.appId==='cancel-queued'){process.stdout.write(JSON.stringify(call)+'\\n'+JSON.stringify({type:'native-cancel',id})+'\\n');responses.delete(id);}
   else if(body.appId==='cancel'){console.log(JSON.stringify(call));}
   else {console.log(JSON.stringify(call));const reply=await pending;value.name=reply.error||reply.value.message;}
  }
 }else if(method==='windows')value=[...windows.values()];
 else if(method==='close'){if(mode==='native'&&windows.get(body.id)?.appId==='cancel'){const id='call-'+body.id;console.log(JSON.stringify({type:'native-cancel',id}));responses.delete(id);}windows.delete(body.id);}
 else if(method==='closeAll')windows.clear();
 else if(method==='import')value={appId:'imported',name:'Imported',path:'pages/index',imported:true};
 res.setHeader('Content-Type','application/json');res.end(JSON.stringify({value}));
});
server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({protocol:mode==='wrong'?2:1,baseUrl:'http://127.0.0.1:'+server.address().port+'/random/sdk/control/',token:'f'.repeat(48)})));
process.stdin.on('end',()=>{if(mode==='ignore-shutdown')return;server.closeAllConnections();server.close(()=>process.exit(0));});if(mode==='ignore-shutdown')process.on('SIGTERM',()=>{});process.stdin.resume();
}
`
  await writeFile(runtimePath, source, { mode: 0o700 })
  t.after(() => rm(dir, { recursive: true, force: true }))
  return { runtimePath, packagesDir: dir, dataDir: dir }
}

async function assertRuntimeExited(options) {
  const pid = Number(await readFile(join(options.dataDir, 'pid'), 'utf8'))
  for (let attempt = 0; attempt < 100; attempt++) {
    try { process.kill(pid, 0) } catch (error) {
      if (error.code === 'ESRCH') return
      throw error
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail('SDK left its runtime process running')
}

test('opens, focuses, lists, imports and closes through the managed protocol', { skip: process.platform === 'win32' }, async t => {
  const options = await fixture(t)
  const host = await Dimina.start(options)
  try {
    const first = await host.openApp({ appId: 'demo', name: 'Demo' })
    assert.equal(first.ready, true)
    assert.equal((await host.windows()).length, 1)
    await first.focus()
    assert.equal((await host.openApp({ appId: 'demo' })).id, first.id)
    assert.equal((await host.importApp('/absolute/package')).appId, 'imported')
    await assert.rejects(host.openApp({ appId: 'broken' }), /startup failed/)
    await first.close()
    await first.close()
    assert.equal((await host.windows()).length, 0)
    const second = await host.openApp({ appId: 'demo' })
    assert.notEqual(first.id, second.id)
    await host.closeAll()
  } finally { await host.dispose() }
  await assert.rejects(host.windows(), /stopped/)
  await host.dispose()
  await assertRuntimeExited(options)
})

test('rejects a mismatched runtime protocol', { skip: process.platform === 'win32' }, async t => {
  const options = await fixture(t, 'wrong')
  await assert.rejects(Dimina.start(options), /handshake/)
  await assertRuntimeExited(options)
})

test('bounds runtime startup and cleans up a child that never responds', { skip: process.platform === 'win32' }, async t => {
  const options = await fixture(t, 'hang')
  await assert.rejects(Dimina.start({ ...options, startupTimeoutMs: 2000 }), /timed out/)
  await assertRuntimeExited(options)
})

test('rejects ambiguous relative executable and data locations', async () => {
  await assert.rejects(Dimina.start({ runtimePath: 'relative', packagesDir: '/apps', dataDir: '/data' }), /absolute/)
})

test('dispatches native requests over private stdio with identity, results and cancellation', { skip: process.platform === 'win32' }, async t => {
  const options = await fixture(t, 'native')
  const host = await Dimina.start(options)
  let cancelled, started
  const running = new Promise(resolve => { started = resolve })
  const cancellation = new Promise(resolve => { cancelled = resolve })
  try {
    await host.registerApi('getNetworkType', async (params, context) => {
      assert.ok(context.windowId)
      if (context.appId === 'error') throw new Error('user denied')
      return { message: params.message + context.appId }
    }, { appIds: ['demo', 'error'] })
    await host.registerApi('openSetting', (_params, context) => {
      started()
      if (context.signal.aborted) cancelled()
      else context.signal.addEventListener('abort', cancelled, { once: true })
      return new Promise(() => {})
    })
    assert.equal((await host.openApp({ appId: 'demo' })).name, '你好demo')
    assert.equal((await host.openApp({ appId: 'error' })).name, 'user denied')
    const pending = await host.openApp({ appId: 'cancel' })
    await running
    await pending.close()
    await Promise.race([cancellation, new Promise((_, reject) => setTimeout(() => reject(new Error('Native call did not cancel')), 1000))])
  } finally { await host.dispose() }
  await assertRuntimeExited(options)
})

for (const mode of ['stall-close', 'ignore-shutdown']) test(`bounds disposal when runtime ${mode} and shares concurrent disposal`, { skip: process.platform === 'win32' }, async t => {
  const options = await fixture(t, mode)
  const host = await Dimina.start(options)
  const first = host.dispose(), second = host.dispose()
  const results = Promise.allSettled([first, second])
  let timer
  try {
    await Promise.race([results, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Runtime disposal exceeded its deadline')), 7500) })])
    assert.equal(first, second, 'concurrent disposal must share a promise')
    await assertRuntimeExited(options)
  } finally {
    clearTimeout(timer)
    const pid = Number(await readFile(join(options.dataDir, 'pid'), 'utf8'))
    try { process.kill(pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
    await results
  }
})

test('does not dispatch a queued native request after its cancellation arrives', { skip: process.platform === 'win32' }, async t => {
  const options = await fixture(t, 'native'), host = await Dimina.start(options)
  let invoked = 0
  try {
    await host.registerApi('openSetting', () => { invoked++; return {} })
    await host.openApp({ appId: 'cancel-queued' })
    assert.equal(invoked, 0, 'cancelled request started its handler')
  } finally { await host.dispose() }
})
