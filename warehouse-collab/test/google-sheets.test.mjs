import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {randomUUID,createHash,createHmac} from 'node:crypto';
import {createGoogleSheetsBackend,callSheets,validateConfig} from '../google-sheets/backend.mjs';
import {createWarehouse} from '../server.mjs';
const secret='warehouse-test-secret-01234567890123456789';
const config={endpoint:'https://script.google.com/macros/s/TEST_DEPLOYMENT/exec',secret};
function fakeGoogle(){
  const grids={},ids={tasks:1,members:2,orders:3,operations:4};
  const props={WAREHOUSE_SECRET:secret,SPREADSHEET_ID:'test',SHEET_IDS:JSON.stringify(ids)};
  let held=false,busy=false,failCommit=false;
  const ctx=vm.createContext({console,Utilities:{getUuid:randomUUID,DigestAlgorithm:{SHA_256:1},Charset:{UTF_8:1},computeDigest:(_,s)=>Array.from(createHash('sha256').update(s).digest()),computeHmacSha256Signature:(s,key)=>Array.from(createHmac('sha256',key).update(s).digest())},
    PropertiesService:{getScriptProperties:()=>({getProperty:k=>props[k],setProperty:(k,v)=>props[k]=v})},
    ContentService:{MimeType:{JSON:1},createTextOutput:s=>({setMimeType:()=>s})},
    LockService:{getScriptLock:()=>({tryLock:()=>{if(busy||held)return false;held=true;return true;},hasLock:()=>held,releaseLock:()=>held=false})},
    Sheets:{Spreadsheets:{Values:{batchGet:()=>({valueRanges:Object.keys(ids).map(k=>({values:grids[ids[k]].rows.slice(1)}))})},get:()=>({sheets:Object.keys(ids).map(k=>({properties:{sheetId:ids[k],gridProperties:{rowCount:grids[ids[k]].size}}}))}),batchUpdate:({requests})=>{
      const next=structuredClone(grids);
      for(const req of requests){if(req.appendDimension){next[req.appendDimension.sheetId].size+=req.appendDimension.length;continue;}
        const u=req.updateCells,g=next[u.start.sheetId];assert.ok(u.start.rowIndex<g.size);
        g.rows[u.start.rowIndex]=u.rows[0].values.map(c=>{const v=c.userEnteredValue;return v.numberValue??v.stringValue??v.boolValue??'';});
      }
      if(failCommit){failCommit=false;throw new Error('simulated atomic batch rejection');}
      Object.assign(grids,next);
    }}}});
  vm.runInContext(fs.readFileSync(new URL('../google-sheets/Code.gs',import.meta.url),'utf8'),ctx);
  for(const [k,id]of Object.entries(ids))grids[id]={size:20,rows:[Array.from(ctx.TABLES[k].headers)]};
  const fetcher=async(_,options)=>{const text=ctx.doPost({postData:{contents:options.body}});return{ok:true,json:async()=>JSON.parse(text)};};
  return{fetcher,ctx,grids,ids,props,setBusy:x=>busy=x,failNextCommit:()=>failCommit=true};
}
test('setup creates a secret only once and validates the bound sheet schema',()=>{
  const g=fakeGoogle();delete g.props.WAREHOUSE_SECRET;
  g.ctx.Utilities.getUuid=randomUUID;
  const byName=name=>Object.keys(g.ctx.TABLES).find(k=>g.ctx.TABLES[k].sheet===name);
  g.ctx.SpreadsheetApp={openById:()=>({getSheetByName:name=>({
    getRange:()=>({getValues:()=>[Array.from(g.ctx.TABLES[byName(name)].headers)],setNumberFormat:()=>{}}),
    getSheetId:()=>g.ids[byName(name)],setFrozenRows:()=>{}
  })})};
  g.ctx.setupWarehouse();const created=g.props.WAREHOUSE_SECRET;assert.match(created,/^[a-f0-9]{64}$/);
  g.ctx.setupWarehouse();assert.equal(g.props.WAREHOUSE_SECRET,created);
  assert.deepEqual(JSON.parse(g.props.SHEET_IDS),g.ids);
});
test('browser client uses scoped membership, dedupes writes and cannot invoke privileged APIs',()=>{
  const g=fakeGoogle(),rpc=(action,args={},token='')=>JSON.parse(JSON.stringify(g.ctx.browserRequest({action,args,token})));
  assert.equal(rpc('ping').data.version,2);
  assert.equal(rpc('health').status,403);assert.equal(rpc('import').status,403);
  assert.equal(rpc('state',{},'c'.repeat(48)).status,401);
  const a='a'.repeat(48),b='b'.repeat(48);
  const made=rpc('create',{name:'云端管理员',title:'直连核验',taskId:'user-chosen',code:'BAD'},a);
  assert.equal(made.ok,true);assert.notEqual(made.data.task.id,'user-chosen');assert.notEqual(made.data.task.code,'BAD');
  const retry=rpc('create',{name:'云端管理员',title:'直连核验'},a);assert.equal(retry.data.task.id,made.data.task.id);
  const joined=rpc('join',{name:'云端成员',code:made.data.task.code},b);assert.equal(joined.data.me.role,'member');
  const op={id:randomUUID(),kind:'scan',barcode:'00000001'};
  assert.equal(rpc('op',op,a).data.orders[0].actual,1);
  assert.equal(rpc('op',{...op,id:randomUUID()},b).data.orders[0].actual,2);
  assert.equal(rpc('op',op,a).data.orders[0].actual,2);
  assert.equal(rpc('op',{id:randomUUID(),kind:'archive'},b).status,403);
  assert.equal(rpc('op',{id:randomUUID(),kind:'archive'},a).data.task.status,'archived');
  assert.equal(rpc('op',{...op,id:randomUUID()},b).status,409);
  assert.equal(g.grids[g.ids.operations].rows.length-1,3);
  g.ctx.HtmlService={XFrameOptionsMode:{ALLOWALL:1},createHtmlOutput:html=>({setXFrameOptionsMode:()=>({html})})};
  const bridge=g.ctx.doGet({parameter:{channel:'e'.repeat(32)}}).html;
  assert.ok(bridge.includes('https://rchen0012.github.io'));assert.ok(bridge.includes('event.source!==window.top'));
  assert.equal(bridge.includes(secret),false);assert.equal(bridge.includes(a),false);
});
test('Google Sheets signed API: atomic updates, dedupe, conflicts and import retry',async()=>{
  const g=fakeGoogle(),rpc=(a,b={},t='')=>callSheets(config,a,b,t,g.fetcher);
  assert.equal((await rpc('health')).ready,true);
  const a='a'.repeat(48),b='b'.repeat(48);
  await rpc('create',{name:'张三',title:'订单核验',taskId:'task1',code:'ABC123'},a);
  await rpc('join',{name:'李四',code:'ABC123'},b);
  const scan={id:randomUUID(),kind:'scan',barcode:'01234567'};
  await rpc('op',scan,a);assert.equal((await rpc('op',scan,a)).orders[0].actual,1);
  await assert.rejects(rpc('op',{...scan,barcode:'99999999'},a),e=>e.status===409);
  await assert.rejects(rpc('op',scan,b),e=>e.status===409);
  await Promise.all(Array.from({length:40},(_,i)=>rpc('op',{id:randomUUID(),kind:'scan',barcode:'01234567'},i%2?a:b)));
  assert.equal((await rpc('state',{},b)).orders[0].actual,41);
  // Simulate server commit followed by a lost response. The same ID recovers without adding twice.
  const pending={id:randomUUID(),kind:'scan',barcode:'01234567'};
  await assert.rejects(callSheets(config,'op',pending,a,async(u,o)=>{await g.fetcher(u,o);throw new Error('response lost');}),e=>e.status===503);
  assert.equal((await rpc('op',pending,a)).orders[0].actual,42);
  await rpc('op',{id:randomUUID(),kind:'estimate',barcode:'01234567',value:100,expectedVersion:0},b);
  await assert.rejects(rpc('op',{id:randomUUID(),kind:'estimate',barcode:'01234567',value:1,expectedVersion:0},a),e=>e.status===409);
  await assert.rejects(rpc('op',{id:randomUUID(),kind:'actual',barcode:'01234567',value:1,expectedVersion:0,reason:'核对'},a),e=>e.status===409);
  // A rejected batch must leave both the order count and dedupe ledger untouched.
  const before=JSON.stringify(g.grids);g.failNextCommit();
  const rejected={id:randomUUID(),kind:'scan',barcode:'01234567'};
  await assert.rejects(rpc('op',rejected,b),e=>e.status===503);
  assert.equal(JSON.stringify(g.grids),before);
  assert.equal((await rpc('op',rejected,b)).orders[0].actual,43);
  g.setBusy(true);await assert.rejects(rpc('state',{},a),e=>e.status===503);g.setBusy(false);
  await assert.rejects(callSheets({...config,secret:'x'.repeat(40)},'state',{},a,g.fetcher),e=>e.status===401);
  await assert.rejects(rpc('op',{id:randomUUID(),kind:'archive'},b),e=>e.status===403);
  await rpc('op',{id:randomUUID(),kind:'archive'},a);
  await assert.rejects(rpc('op',{id:randomUUID(),kind:'scan',barcode:'01234567'},b),e=>e.status===409);
  assert.ok((await rpc('history',{},b)).logs.some(x=>x.actor==='李四'));
  assert.equal((await rpc('state',{},a)).orders[0].barcode,'01234567');
  const imported=fakeGoogle();const source={};
  for(const [key,id]of Object.entries(g.ids))source[key]=g.grids[id].rows.slice(1).filter(Boolean).map(row=>Object.fromEntries(Array.from(g.ctx.TABLES[key].keys,(k,i)=>[k,row[i]])));
  const migrated=await callSheets(config,'import',source,'',imported.fetcher);
  assert.equal(migrated.imported.orders,1);
  assert.equal((await callSheets(config,'import',source,'',imported.fetcher)).duplicate,true);
  assert.equal((await callSheets(config,'state',{},a,imported.fetcher)).orders[0].actual,43);
});
test('Google Sheets HTTP bridge retains upstream uncertainty and blocks cross-origin mutation',async()=>{
  const g=fakeGoogle();let offline=false;
  const app=createGoogleSheetsBackend({config,serveStatic:(_,res)=>{res.writeHead(404);res.end();},fetcher:(...args)=>offline?Promise.reject(new Error('offline')):g.fetcher(...args),pollMs:100});
  const server=http.createServer(app.handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  try{
    let r=await fetch(base+'/api/create',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'管理员',title:'云端任务'})});
    const a=await r.json();assert.equal(a.me.role,'admin');
    const headers={'Content-Type':'application/json',Authorization:'Bearer '+a.token};
    const op={id:randomUUID(),kind:'scan',barcode:'00001234'};
    r=await fetch(base+'/api/op',{method:'POST',headers:{...headers,Origin:'https://attacker.invalid'},body:JSON.stringify(op)});assert.equal(r.status,403);
    r=await fetch(base+'/api/op',{method:'POST',headers,body:JSON.stringify(op)});assert.equal((await r.json()).orders[0].actual,1);
    offline=true;r=await fetch(base+'/api/op',{method:'POST',headers,body:JSON.stringify({...op,id:randomUUID()})});assert.equal(r.status,503);
    assert.match((await r.json()).error,/结果待确认/);
  }finally{app.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
  assert.throws(()=>validateConfig({...config,endpoint:'https://attacker.invalid/exec'}));
});
test('migration freeze prevents local writes without deleting existing data',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'warehouse-test-'));
  const app=createWarehouse({dataDir:dir}),server=http.createServer(app.handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  try{
    let r=await fetch(base+'/api/create',{method:'POST',body:JSON.stringify({name:'管理员',title:'待迁移任务'})});const a=await r.json();
    fs.writeFileSync(path.join(dir,'migration-lock.json'),'{}');
    r=await fetch(base+'/api/op',{method:'POST',headers:{Authorization:'Bearer '+a.token},body:JSON.stringify({id:randomUUID(),kind:'scan',barcode:'00001234'})});assert.equal(r.status,503);
    r=await fetch(base+'/api/state',{headers:{Authorization:'Bearer '+a.token}});assert.equal((await r.json()).orders.length,0);
  }finally{
    app.close();server.closeAllConnections();await new Promise(r=>server.close(r));
    const resolved=path.resolve(dir);assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));assert.ok(path.basename(resolved).startsWith('warehouse-test-'));fs.rmSync(resolved,{recursive:true,force:true});
  }
});
