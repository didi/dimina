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
writeFileSync(${JSON.stringify(join(dir, 'pid'))},String(process.pid));
const mode=${JSON.stringify(mode)};
if(mode==='hang'){process.stdin.resume();}else{
const windows=new Map();let next=0;
const server=http.createServer(async(req,res)=>{
 if(req.headers.authorization!=='Bearer '+ 'f'.repeat(48)){res.writeHead(401);res.end();return;}
 let raw='';for await(const chunk of req)raw+=chunk;
 const body=raw?JSON.parse(raw):{};const method=req.url.split('/').at(-1);let value=null;
 if(method==='open'){
  if(body.appId==='broken'){res.writeHead(400);res.end(JSON.stringify({error:'startup failed'}));return;}
  value=[...windows.values()].find(w=>w.appId===body.appId);
  if(!value){value={id:String(++next),appId:body.appId,name:body.name||body.appId,ready:true};windows.set(value.id,value);}
 }else if(method==='windows')value=[...windows.values()];
 else if(method==='close')windows.delete(body.id);
 else if(method==='closeAll')windows.clear();
 else if(method==='import')value={appId:'imported',name:'Imported',path:'pages/index',imported:true};
 res.setHeader('Content-Type','application/json');res.end(JSON.stringify({value}));
});
server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({protocol:mode==='wrong'?2:1,baseUrl:'http://127.0.0.1:'+server.address().port+'/random/sdk/control/',token:'f'.repeat(48)})));
process.stdin.on('end',()=>{server.closeAllConnections();server.close(()=>process.exit(0));});process.stdin.resume();
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
