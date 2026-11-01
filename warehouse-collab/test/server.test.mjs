import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createWarehouse } from '../server.mjs';

test('多人并发、去重、冲突、权限、任务隔离、持久化', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'warehouse-test-'));
  let app=createWarehouse({dataDir:dir}), server=http.createServer(app.handler);
  async function start(){await new Promise(r=>server.listen(0,'127.0.0.1',r));}
  await start();
  async function request(route,body,token,origin){
    const r=await fetch(`http://127.0.0.1:${server.address().port}${route}`,{method:body?'POST':'GET',headers:{...(body?{'Content-Type':'application/json'}:{}),...(token?{Authorization:'Bearer '+token}:{}),...(origin?{Origin:origin}:{})},body:body?JSON.stringify(body):undefined});
    return {status:r.status,data:await r.json()};
  }
  const op=(token,b)=>request('/api/op',{id:randomUUID(),...b},token);
  const stop=async()=>{app.close();server.closeAllConnections();await new Promise(r=>server.close(r));};
  try{
    const a=(await request('/api/create',{name:'张三',title:'共同核验'})).data;
    assert.ok(a.token);assert.equal(a.me.role,'admin');
    const b=(await request('/api/join',{name:'李四',code:a.task.code})).data;
    const c=(await request('/api/create',{name:'王五',title:'独立任务'})).data;
    const results=await Promise.all(Array.from({length:80},(_,i)=>op(i%2?a.token:b.token,{kind:'scan',barcode:'01234567'})));
    assert.ok(results.every(r=>r.status===200));
    let state=(await request('/api/state',null,a.token)).data;
    assert.equal(state.orders[0].actual,80);assert.equal(state.orders[0].scanCount,80);
    assert.equal(state.orders[0].hasFilledEstimate,false);
    const body={id:randomUUID(),kind:'scan',barcode:'01234567'};
    await request('/api/op',body,b.token);
    const repeat=await request('/api/op',body,b.token);
    assert.equal(repeat.data.orders[0].actual,81);
    assert.equal((await request('/api/op',{...body,barcode:'12345678'},b.token)).status,409);
    assert.equal((await request('/api/op',body,a.token)).status,409);
    assert.equal((await request('/api/state',null,c.token)).data.orders.length,0);
    assert.equal((await op(b.token,{kind:'estimate',barcode:'01234567',value:100,expectedVersion:0})).status,200);
    assert.equal((await op(a.token,{kind:'estimate',barcode:'01234567',value:999,expectedVersion:0})).status,409);
    // A scan does not make the independent estimate field stale.
    await op(b.token,{kind:'scan',barcode:'01234567'});
    assert.equal((await op(a.token,{kind:'estimate',barcode:'01234567',value:101,expectedVersion:1})).status,200);
    assert.equal((await op(a.token,{kind:'actual',barcode:'01234567',value:1,expectedVersion:0,reason:'核对'})).status,409);
    assert.equal((await op(a.token,{kind:'adjust',barcode:'01234567',value:-1,reason:'撤销误扫'})).data.orders[0].actual,81);
    assert.equal((await op(b.token,{kind:'adjust',barcode:'01234567',value:-1})).status,400);
    assert.equal((await op(b.token,{kind:'scan',barcode:'123456789'})).status,400);
    assert.equal((await op(b.token,{kind:'scan',barcode:'AB123456'})).status,400);
    assert.equal((await request('/api/op',{id:randomUUID(),kind:'scan',barcode:'01234567'},a.token,'https://attacker.invalid')).status,403);
    assert.equal((await request('/api/state')).status,401);
    assert.equal((await op(b.token,{kind:'archive'})).status,403);
    // A real streaming client gets the current state and the next committed update.
    const ac=new AbortController();
    const stream=await fetch(`http://127.0.0.1:${server.address().port}/api/events`,{headers:{Authorization:'Bearer '+b.token},signal:ac.signal});
    assert.equal(stream.status,200);assert.match(stream.headers.get('content-type'),/event-stream/);
    const reader=stream.body.getReader();
    const initial=new TextDecoder().decode((await reader.read()).value);
    assert.match(initial,/"actual":81/);
    await op(a.token,{kind:'scan',barcode:'01234567'});
    const update=new TextDecoder().decode((await reader.read()).value);
    assert.match(update,/"actual":82/);ac.abort();await reader.cancel().catch(()=>{});
    const history=(await request('/api/history',null,a.token)).data.logs;
    assert.equal(history.filter(l=>l.kind==='scan').length,83);
    assert.ok(history.some(l=>l.actor==='李四'));
    assert.ok(history.some(l=>JSON.parse(l.payload)[4]==='撤销误扫'));
    await stop();
    app=createWarehouse({dataDir:dir});server=http.createServer(app.handler);await start();
    state=(await request('/api/state',null,a.token)).data;
    assert.equal(state.orders[0].actual,82);assert.equal(state.orders[0].estimate,101);
    assert.equal((await op(a.token,{kind:'archive'})).data.task.status,'archived');
    assert.equal((await op(b.token,{kind:'scan',barcode:'01234567'})).status,409);
    assert.equal((await request('/api/join',{name:'后来者',code:a.task.code})).status,409);
    // Previously committed retries remain safe even after archival.
    assert.equal((await request('/api/op',body,b.token)).data.orders[0].actual,82);
    assert.equal((await request('/api/history',null,b.token)).status,200);
  }finally{
    await stop();
    const target=path.resolve(dir);
    if(path.dirname(target)!==path.resolve(os.tmpdir()) || !path.basename(target).startsWith('warehouse-test-')) throw new Error('Unexpected test cleanup target');
    fs.rmSync(target,{recursive:true,force:true});
  }
});
