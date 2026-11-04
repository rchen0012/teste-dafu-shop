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
  let held=false,busy=false,failCommit=false,metadata=[];
  const ctx=vm.createContext({console,Utilities:{getUuid:randomUUID,DigestAlgorithm:{SHA_256:1},Charset:{UTF_8:1},computeDigest:(_,s)=>Array.from(createHash('sha256').update(s).digest()),computeHmacSha256Signature:(s,key)=>Array.from(createHmac('sha256',key).update(s).digest())},
    PropertiesService:{getScriptProperties:()=>({getProperty:k=>props[k],setProperty:(k,v)=>props[k]=v,deleteProperty:k=>delete props[k]})},
    ContentService:{MimeType:{JSON:1},createTextOutput:s=>({setMimeType:()=>s})},
    LockService:{getScriptLock:()=>({tryLock:()=>{if(busy||held)return false;held=true;return true;},hasLock:()=>held,releaseLock:()=>held=false})},
    Sheets:{Spreadsheets:{Values:{batchGet:()=>({valueRanges:Object.keys(ids).map(k=>({values:grids[ids[k]].rows.slice(1)}))})},get:()=>({developerMetadata:metadata,sheets:Object.keys(grids).map(k=>({properties:{sheetId:Number(k),title:grids[k].title||k,gridProperties:{rowCount:grids[k].size,columnCount:26}}}))}),batchUpdate:({requests})=>{
      const next=structuredClone(grids),nextMetadata=structuredClone(metadata);
      for(const req of requests){if(req.appendDimension){next[req.appendDimension.sheetId].size+=req.appendDimension.length;continue;}
        if(req.duplicateSheet){const d=req.duplicateSheet,id=Math.max(...Object.keys(next).map(Number))+1;next[id]=structuredClone(next[d.sourceSheetId]);next[id].title=d.newSheetName;continue;}
        if(req.createDeveloperMetadata){nextMetadata.push(req.createDeveloperMetadata.developerMetadata);continue;}
        if(req.updateCells.range){const r=req.updateCells.range,g=next[r.sheetId];g.rows=g.rows.slice(0,r.startRowIndex);continue;}
        const u=req.updateCells,g=next[u.start.sheetId];assert.ok(u.start.rowIndex<g.size);
        g.rows[u.start.rowIndex]=u.rows[0].values.map(c=>{const v=c.userEnteredValue;return v.numberValue??v.stringValue??v.boolValue??'';});
      }
      if(failCommit){failCommit=false;throw new Error('simulated atomic batch rejection');}
      Object.assign(grids,next);metadata=nextMetadata;
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

test('manual batches merge two offline members exactly once and preserve rejected suffix',()=>{
 const g=fakeGoogle(),rpc=(action,args={},token='a'.repeat(48))=>JSON.parse(JSON.stringify(g.ctx.browserRequest({action,args,token})));
 const a='a'.repeat(48),b='b'.repeat(48);
 const made=rpc('create',{name:'管理员',title:'手动同步'},a).data;
 rpc('join',{name:'成员',code:made.task.code},b);
 const scan=()=>({id:randomUUID(),kind:'scan',barcode:'00000009'});
 const one=[scan(),{id:randomUUID(),kind:'estimate',barcode:'00000009',value:8,expectedVersion:0},scan()];
 assert.equal(rpc('state',{},a).data.orders.length,0);
 let result=rpc('sync',{operations:one},a).data;
 assert.equal(result.accepted.length,3);assert.equal(result.snapshot.orders[0].actual,2);
 assert.equal(rpc('sync',{operations:one},a).data.snapshot.orders[0].actual,2);
 const other=[scan(),{id:randomUUID(),kind:'estimate',barcode:'00000009',value:10,expectedVersion:0},scan()];
 result=rpc('sync',{operations:other},b).data;
 assert.deepEqual(result.accepted,[other[0].id]);assert.equal(result.conflict.status,409);
 assert.equal(result.snapshot.orders[0].actual,3);assert.equal(result.snapshot.orders[0].estimate,8);
 // Failed negative adjustment must not leak its mutation into the committed snapshot.
 const bad={id:randomUUID(),kind:'adjust',barcode:'00000009',value:-99,reason:'测试'};
 result=rpc('sync',{operations:[bad]},b).data;
 assert.equal(result.accepted.length,0);assert.equal(result.snapshot.orders[0].actual,3);
 result=rpc('sync',{operations:[other[2]]},b).data;assert.equal(result.snapshot.orders[0].actual,4);
 const flag={id:randomUUID(),kind:'done',barcode:'00000009',value:1};
 assert.equal(rpc('sync',{operations:[flag]},a).data.snapshot.orders[0].done,true);
 assert.equal(rpc('state',{},b).data.orders[0].done,true);
 assert.ok(rpc('history',{},a).data.logs.every(l=>l.id));
 const last=scan();g.failNextCommit();assert.equal(rpc('sync',{operations:[last]},b).ok,false);
 assert.equal(rpc('state',{},b).data.orders[0].actual,4);
 assert.equal(rpc('sync',{operations:[last]},b).data.snapshot.orders[0].actual,5);
 assert.equal(rpc('sync',{operations:[last]},b).data.snapshot.orders[0].actual,5);
 assert.equal(rpc('sync',{operations:[]},'c'.repeat(48)).status,401);
 rpc('op',{id:randomUUID(),kind:'archive'},a);
 assert.equal(rpc('sync',{operations:[scan()]},b).data.conflict.status,409);
});

test('new UI stores scans locally until manual refresh, survives reload, and merges two members',async()=>{
 const g=fakeGoogle();
 const html=fs.readFileSync(new URL('../../manual-preview.html',import.meta.url),'utf8');
 function browser(sharedStorage=new Map()){
  const elements=new Map();
  class Element{
   constructor(id=''){this.id=id;this.value='';this.disabled=false;this.hidden=false;this.style={};this.dataset={};this.children=[];this.textContent='';this.parentElement={querySelector:()=>null};const s=new Set();this.classList={add:x=>s.add(x),remove:x=>s.delete(x),contains:x=>s.has(x),toggle:(x,force)=>{if(force===undefined)force=!s.has(x);if(force)s.add(x);else s.delete(x);return force;}};}
   set innerHTML(text){this._html=text;for(const match of text.matchAll(/id="([^"]+)"/g))get(match[1]);}
   get innerHTML(){return this._html||''}
   addEventListener(name,fn){(this.events||={})[name]=fn;}
   appendChild(x){this.children.push(x);return x;}append(x){this.children.push(x)}replaceChildren(){this.children=[];}before(){}setAttribute(){}focus(){}closest(){return new Element()}remove(){}
   querySelector(){return new Element()}
   querySelectorAll(){return []}
  }
  const get=id=>{if(!elements.has(id))elements.set(id,new Element(id));return elements.get(id)};
  for(const m of html.matchAll(/id="([^"]+)"/g))get(m[1]);
  const store={getItem:k=>sharedStorage.get(k)||null,setItem:(k,v)=>sharedStorage.set(k,v),removeItem:k=>sharedStorage.delete(k)};
  let calls=0,failHistory=false,prompts=[];
  const ctx=vm.createContext({console,structuredClone,Date,JSON,Map,Set,Math,Number,String,Array,RegExp,Promise,Error,URL,Blob,crypto:{randomUUID},localStorage:store,navigator:{},setTimeout:()=>0,clearTimeout:()=>{},confirm:()=>true,prompt:()=>prompts.shift()??null,
   document:{getElementById:get,querySelector:s=>get(s),querySelectorAll:()=>[],createElement:()=>new Element(),addEventListener:()=>{}},
   window:{scrollY:0,addEventListener:()=>{}},
   CloudSheets:{newToken:()=>randomUUID().replaceAll('-','')+randomUUID().replaceAll('-','').slice(0,16),call:async(action,args,token)=>{calls++;if(action==='history'&&failHistory){failHistory=false;throw Object.assign(new Error('history connection interrupted'),{status:503});}const r=JSON.parse(JSON.stringify(g.ctx.browserRequest({action,args,token})));if(!r.ok)throw Object.assign(new Error(r.error),{status:r.status});return r.data;}}
  });
  vm.runInContext(fs.readFileSync(new URL('../../assets/manual-queue.js',import.meta.url),'utf8'),ctx);
  vm.runInContext(fs.readFileSync(new URL('../../assets/mobile-ui.js',import.meta.url),'utf8'),ctx);
  vm.runInContext(fs.readFileSync(new URL('../../assets/order-check.js',import.meta.url),'utf8'),ctx);
  vm.runInContext(fs.readFileSync(new URL('../../assets/local-task-state.js',import.meta.url),'utf8'),ctx);
  for(const script of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))vm.runInContext(script[1],ctx);
  return{get,store:sharedStorage,calls:()=>calls,answerPrompt:value=>prompts.push(value),failNextHistory:()=>failHistory=true,saved:()=>JSON.parse(sharedStorage.get('box_verify_manual_v2')),scan:code=>{get('barcode').value=code;get('scanBtn').onclick();}};
 }
 const a=browser();assert.equal(a.calls(),0,'opening UI must not contact cloud');
 a.get('newTaskCode').value='手动验收';a.get('newTaskMember').value='管理员';
 await a.get('createTaskBtn').onclick();const created=a.saved();assert.ok(created.cloud.token);
 const initialCalls=a.calls();a.scan('00000002');a.scan('00000002');
 a.get('estimateInput').value='8';a.get('saveEstimate').onclick();
 assert.equal(a.calls(),initialCalls,'scans must not upload');
 assert.equal(a.saved().orders[0].actual,2);assert.equal(a.saved().cloud.outbox.length,3);assert.match(a.get('exceptionList').innerHTML,/少扫 6 箱/);assert.match(a.get('exceptionList').innerHTML,/查看全任务扫码序号和时间/);assert.match(a.get('exceptionList').innerHTML,/管理员/);
 const restored=browser(a.store);assert.equal(restored.calls(),0);assert.equal(restored.saved().cloud.outbox.length,3);
 await restored.get('manualSync').onclick();assert.equal(restored.saved().cloud.outbox.length,0);
 assert.equal(restored.saved().orders[0].actual,2);
 const b=browser();b.get('newTaskMember').value='成员';b.get('joinCloudCode').value=restored.saved().cloud.code;
 await b.get('joinCloudTask').onclick();
 restored.scan('00000002');b.scan('00000002');
 assert.equal(restored.saved().orders[0].actual,3);assert.equal(b.saved().orders[0].actual,3);
 await b.get('manualSync').onclick();await restored.get('manualSync').onclick();
 assert.equal(restored.saved().orders[0].actual,4);assert.equal(restored.saved().cloud.outbox.length,0);
 assert.equal(restored.saved().logs.filter(l=>l.globalSeq).length,4);
 restored.scan('00000002');g.grids[g.ids.tasks].rows=g.grids[g.ids.tasks].rows.slice(0,1);g.grids[g.ids.orders].rows=g.grids[g.ids.orders].rows.slice(0,1);
 await restored.get('manualSync').onclick();assert.equal(restored.saved().cloud.syncErrorStatus,404);assert.equal(restored.saved().cloud.outbox.length,1);
 await restored.get('recoverMissingTask').onclick();assert.equal(restored.saved().cloud.outbox.length,0);assert.equal(restored.saved().orders[0].actual,5);
 restored.scan('00000002');restored.failNextHistory();await restored.get('manualSync').onclick();assert.equal(restored.saved().cloud.outbox.length,0);assert.equal(restored.saved().cloud.base[0].actual,6,'acknowledged base survives history download failure');
 restored.get('exceptionBtn').onclick();assert.equal(restored.saved().cloud.outbox.at(-1).value,1);restored.get('exceptionBtn').onclick();assert.equal(restored.saved().cloud.outbox.at(-1).value,0);assert.equal(restored.saved().orders[0].exception,true,'removing manual flag cannot hide shortage');
 restored.answerPrompt('6');restored.get('editEstimateBtn').onclick();await restored.get('manualSync').onclick();assert.equal(restored.saved().orders[0].exception,false);assert.match(restored.get('exceptionList').innerHTML,/暂无异常订单/);
 restored.scan('00000002');const tokenBefore=restored.saved().cloud.token,pendingId=restored.saved().cloud.outbox[0].id;
 const drift=restored.saved();drift.orders[0].actual=999;restored.store.set('box_verify_manual_v2',JSON.stringify(drift));
 const cacheDevice=browser(restored.store);await cacheDevice.get('confirmLocalCache').onclick();
 assert.equal(cacheDevice.saved().cloud.token,tokenBefore);assert.equal(cacheDevice.saved().cloud.role,'admin');assert.equal(cacheDevice.saved().cloud.outbox[0].id,pendingId);assert.equal(cacheDevice.saved().orders[0].actual,7,'cache refresh rebuilds latest cloud base plus unsent delta');
 assert.ok([...cacheDevice.store.keys()].some(k=>k.startsWith('box_verify_backup_')));
 const staleTab=browser(cacheDevice.store);
 await cacheDevice.get('endTaskBtn').onclick();assert.equal(cacheDevice.saved().taskEnded,true);assert.equal(cacheDevice.saved().cloud.outbox.length,0);assert.equal(cacheDevice.saved().orders[0].actual,7,'ending automatically confirms pending scan first');
 await staleTab.get('endTaskBtn').onclick();assert.equal(staleTab.saved().taskEnded,true);assert.equal(staleTab.saved().cloud.outbox.length,0,'stale tab confirms acknowledged scan and already ended task');

});

test('camera automatically rearms after box leaves, and pull cancellation never syncs',()=>{
 const ctx=vm.createContext({module:{exports:{}}});vm.runInContext(fs.readFileSync(new URL('../../assets/mobile-ui.js',import.meta.url),'utf8'),ctx);
 const {MobileScanGate,PullSyncGesture}=ctx.module.exports,g=new MobileScanGate();
 assert.equal(g.hit('00000001',0),true);assert.equal(g.hit('00000001',100),false);
 for(let t=200;t<1000;t+=100){g.hit('00000001',t);g.miss(t+20);}assert.equal(g.hit('00000001',1000),false,'one visible box cannot repeat');
 for(let t=1100;t<=2000;t+=100)g.miss(t);assert.equal(g.hit('00000001',2100),true,'same order next box automatically scans after removal');
 assert.equal(g.hit('00000002',2200),true,'different order scans continuously');
 const pull=new PullSyncGesture();pull.start(10,10);pull.move(10,60);assert.equal(pull.finish(),false);pull.start(10,10);pull.move(10,110);assert.equal(pull.finish(),true);assert.equal(pull.finish(),false);pull.start(10,10);pull.move(100,150);assert.equal(pull.finish(),false);pull.start(10,10);pull.move(10,110);pull.cancel();assert.equal(pull.finish(),false);
});
test('new task codes are eight digits and legacy tasks keep eight-digit aliases plus original access',()=>{
 const g=fakeGoogle(),rpc=(action,args,token)=>JSON.parse(JSON.stringify(g.ctx.browserRequest({action,args,token})));
 const a='1'.repeat(48),b='2'.repeat(48),c='3'.repeat(48),d='4'.repeat(48);
 const made=rpc('create',{name:'管理员',title:'8位码'},a);assert.match(made.data.task.code,/^\d{8}$/);
 const tables=g.ctx.readTables_('test',g.ids),legacy=g.ctx.plan_(tables,'create',{name:'旧成员',title:'旧任务',taskId:'legacy-task-id',code:'ABCDEF0123456789'},b);g.ctx.commit_('test',tables,legacy.changes);
 const code=rpc('state',{},b).data.task.code;assert.match(code,/^\d{8}$/);assert.notEqual(code,made.data.task.code);
 assert.equal(rpc('join',{name:'短码加入',code},c).data.task.id,'legacy-task-id');
 assert.equal(rpc('join',{name:'旧码兼容',code:'ABCDEF0123456789'},d).data.task.code,code);
 assert.equal(rpc('state',{},a).data.task.code,made.data.task.code);
});

test('admin reset requires password and role, backs up four tables atomically, and safely retries after lost response',()=>{
 const g=fakeGoogle(),rpc=(action,args={},token='a'.repeat(48))=>JSON.parse(JSON.stringify(g.ctx.browserRequest({action,args,token})));
 const a='a'.repeat(48),b='b'.repeat(48);const s=rpc('create',{name:'管理员',title:'重置测试'},a).data;rpc('join',{name:'成员',code:s.task.code},b);rpc('op',{id:randomUUID(),kind:'scan',barcode:'00000001'},a);
 assert.equal(rpc('resetStatus',{},a).data.configured,false);
 g.props.RESET_PASSWORD_SETUP='test-reset-password-only';g.ctx.configureResetPassword();assert.equal(g.props.RESET_PASSWORD_SETUP,undefined);assert.ok(g.props.RESET_PASSWORD_HASH);assert.notEqual(g.props.RESET_PASSWORD_HASH,'test-reset-password-only');
 assert.equal(rpc('resetStatus',{},a).data.configured,true);
 const args={id:randomUUID(),password:'test-reset-password-only',confirm:'123456'};
 assert.equal(rpc('reset',{...args,password:'wrong-password'},a).status,403);assert.equal(Object.keys(g.grids).length,4);
 assert.equal(rpc('reset',args,b).status,403);assert.equal(rpc('reset',{...args,confirm:'错误'},a).status,400);assert.equal(rpc('reset',{...args,confirm:'清除全部数据'},a).status,400);
 g.failNextCommit();assert.equal(rpc('reset',args,a).ok,false);assert.equal(g.grids[g.ids.tasks].rows.length,2);assert.equal(Object.keys(g.grids).length,4);
 const reset=rpc('reset',args,a);assert.equal(reset.ok,true);assert.equal(reset.data.backups.length,4);assert.equal(Object.keys(g.grids).length,8);
 for(const id of Object.values(g.ids))assert.equal(g.grids[id].rows.length,1,'headers retained, all data rows cleared');
 assert.ok(Object.values(g.grids).some(x=>x.title?.includes('订单')&&x.rows.length===2),'backup contains original order');
 assert.equal(rpc('state',{},a).status,401);assert.equal(rpc('reset',args,a).data.duplicate,true);assert.equal(Object.keys(g.grids).length,8,'retry cannot duplicate backup or reset');
});
test('only the original task admin can recover missing tasks, using its local base without losing pending operations',()=>{
 const g=fakeGoogle(),rpc=(action,args={},token='a'.repeat(48))=>JSON.parse(JSON.stringify(g.ctx.browserRequest({action,args,token})));
 const a='a'.repeat(48),b='b'.repeat(48),s=rpc('create',{name:'管理员',title:'原任务'},a).data;rpc('join',{name:'成员',code:s.task.code},b);
 const saved=rpc('op',{id:randomUUID(),kind:'scan',barcode:'00000002'},a).data;
 g.grids[g.ids.tasks].rows=g.grids[g.ids.tasks].rows.slice(0,1);g.grids[g.ids.orders].rows=g.grids[g.ids.orders].rows.slice(0,1);
 assert.equal(rpc('state',{},a).status,404);
 const args={taskId:s.task.id,title:s.task.title,code:s.task.code,revision:saved.task.revision,base:saved.orders};
 assert.equal(rpc('recover',args,b).status,403);assert.equal(rpc('recover',{...args,taskId:'other'},a).status,409);
 assert.equal(rpc('recover',args,a).data.orders[0].actual,1);assert.equal(rpc('recover',args,a).data.orders[0].actual,1);
 assert.equal(rpc('sync',{operations:[{id:randomUUID(),kind:'scan',barcode:'00000002'}]},a).data.snapshot.orders[0].actual,2);
});

test('shortages excess and manual marks stay distinct, including completed and zero-count orders',()=>{
 const ctx=vm.createContext({module:{exports:{}}});vm.runInContext(fs.readFileSync(new URL('../../assets/order-check.js',import.meta.url),'utf8'),ctx);const check=ctx.module.exports;
 for(const [actual,estimate,difference,label]of [[2,5,-3,'少扫 3 箱'],[0,5,-5,'少扫 5 箱'],[7,5,2,'超出 2 箱'],[5,5,0,'数量一致']]){
  const o={id:'00000001',actual,estimate,done:true,manualAbnormal:false};check.normalize([o]);assert.equal(o.exception,difference!==0);assert.equal(check.get(o).difference,difference);assert.equal(check.get(o).label,label);
 }
 const pending={actual:1,estimate:null,manualAbnormal:false};assert.equal(check.get(pending).abnormal,false);assert.equal(check.get(pending).label,'待填预估');
 assert.equal(check.get({actual:5,estimate:5,manualAbnormal:true}).label,'人工标记异常');
 const migrated={id:'00000001',actual:3,estimate:5,exception:false};check.normalize([migrated],[{barcode:migrated.id,abnormal:false}],[]);assert.equal(migrated.manualAbnormal,false);assert.equal(migrated.exception,true);
});
test('camera uses a wider responsive region and rearms quickly without repeating a stationary code',async()=>{
 const ctx=vm.createContext({module:{exports:{}}});vm.runInContext(fs.readFileSync(new URL('../../assets/mobile-ui.js',import.meta.url),'utf8'),ctx);const {MobileScanGate,CameraScanConfig}=ctx.module.exports;
 const gate=new MobileScanGate();assert.equal(gate.hit('00000001',0),true);
 for(let t=50;t<500;t+=50){gate.hit('00000001',t);gate.miss(t+10);}assert.equal(gate.hit('00000001',500),false);
 gate.miss(650);gate.miss(850);gate.miss(1050);assert.equal(gate.hit('00000001',1051),true,'automatic same-order next box after 550 ms absence');
 assert.equal(gate.hit('00000002',1060),true,'new order needs no delay');
 const config=CameraScanConfig.options();assert.equal(config.fps,20);assert.equal(config.videoConstraints.facingMode.ideal,'environment');
 for(const [w,h]of [[240,180],[320,240],[390,290],[800,600]]){const box=config.qrbox(w,h);assert.ok(box.width<w&&box.width>=w*.85-1||w>720);assert.ok(box.height<=h);}
 assert.equal(CameraScanConfig.options(false).videoConstraints,undefined);
 let focus;await CameraScanConfig.focus({getRunningTrackCapabilities:()=>({focusMode:['continuous']}),applyVideoConstraints:async value=>focus=value});assert.equal(focus.advanced[0].focusMode,'continuous');
 await CameraScanConfig.focus({getRunningTrackCapabilities:()=>{throw new Error('unsupported')}});
});

test('task closure is idempotent across independent archive requests and still enforces admin role',()=>{
 const g=fakeGoogle(),rpc=(action,args={},token='a'.repeat(48))=>JSON.parse(JSON.stringify(g.ctx.browserRequest({action,args,token})));
 const a='a'.repeat(48),b='b'.repeat(48),made=rpc('create',{name:'管理员',title:'状态一致性'},a).data;
 rpc('join',{name:'成员',code:made.task.code},b);
 const first=rpc('op',{id:randomUUID(),kind:'archive'},a).data,second=rpc('op',{id:randomUUID(),kind:'archive'},a);
 assert.equal(second.ok,true);assert.equal(second.data.task.revision,first.task.revision);assert.equal(rpc('history',{},a).data.logs.filter(l=>l.kind==='archive').length,1);
 assert.equal(rpc('op',{id:randomUUID(),kind:'archive'},b).status,403);
});
test('local cache reconciliation retains unconfirmed writes and never uses a mismatched payload as acknowledgement',()=>{
 const ctx=vm.createContext({module:{exports:{}}});vm.runInContext(fs.readFileSync(new URL('../../assets/local-task-state.js',import.meta.url),'utf8'),ctx);
 const helper=ctx.module.exports,scan={id:'a'.repeat(24),kind:'scan',barcode:'00000001'},other={id:'b'.repeat(24),kind:'scan',barcode:'00000002'},archive={id:'c'.repeat(24),kind:'archive'};
 const logs=[{id:scan.id,kind:'scan',payload:JSON.stringify(['scan','00000001',null,null,null])},{id:other.id,kind:'scan',payload:JSON.stringify(['scan','00000003',null,null,null])}];
 const result=helper.pendingAfterRefresh({outbox:[scan,other,archive]},{task:{status:'archived'}},logs);
 assert.equal(result.length,1);assert.equal(result[0].id,other.id);
 const html=fs.readFileSync(new URL('../../index.html',import.meta.url),'utf8');
 assert.ok(html.indexOf('class="scan-top"')<html.indexOf('class="hero"'),'scanner is first');
 assert.ok(html.includes('@media(min-width:900px)'));assert.ok(html.includes('max-width:1440px'));assert.ok(!html.includes('localStorage.clear('));
 assert.ok(html.includes('placeholder="请输入：123456"'));assert.ok(html.includes('state.cloud.outbox.length){const ok=await syncCloud()'));
});
