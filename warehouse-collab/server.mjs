import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { networkInterfaces } from 'node:os';
import { createGoogleSheetsBackend } from './google-sheets/backend.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const hash = s => createHash('sha256').update(s).digest('hex');
const random = () => randomBytes(24).toString('hex');
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
export function serveWarehouseStatic(req,res,url=new URL(req.url,'http://local')) {
  const routes={'/':'index.html','/index.html':'index.html','/collaboration.js':'collaboration.js','/collaboration.css':'collaboration.css','/vendor/html5-qrcode.min.js':'vendor/html5-qrcode.min.js'};
  if(req.method!=='GET') {res.writeHead(405);res.end();return;}
  let file=routes[url.pathname],mime;
  if(url.pathname==='/warehouse-root.cer') {
    file=path.join(ROOT,'certs','warehouse-root.cer');mime='application/x-x509-ca-cert';
    res.setHeader('Content-Disposition','attachment; filename="warehouse-root.cer"');
  }else if(file){mime=(file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html')+'; charset=utf-8';file=path.join(ROOT,'public',file);}
  if(!file||!fs.existsSync(file)){res.writeHead(404,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify({error:'页面或证书不存在'}));return;}
  res.writeHead(200,{'Content-Type':mime,'Cache-Control':'no-cache'});fs.createReadStream(file).pipe(res);
}
export function createWarehouse({ dataDir = path.join(ROOT, 'data') } = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'warehouse.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, code TEXT UNIQUE NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', revision INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS members(token TEXT PRIMARY KEY, task TEXT NOT NULL REFERENCES tasks(id), name TEXT NOT NULL, role TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS orders(task TEXT NOT NULL REFERENCES tasks(id), barcode TEXT NOT NULL, actual INTEGER NOT NULL DEFAULT 0 CHECK(actual>=0 AND actual<=999999999), estimate INTEGER NOT NULL DEFAULT 0, filled INTEGER NOT NULL DEFAULT 0, abnormal INTEGER NOT NULL DEFAULT 0, scans INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 0, estimateVersion INTEGER NOT NULL DEFAULT 0, actualVersion INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(task,barcode));
    CREATE TABLE IF NOT EXISTS operations(task TEXT NOT NULL, id TEXT NOT NULL, token TEXT NOT NULL, payload TEXT NOT NULL, actor TEXT NOT NULL, kind TEXT NOT NULL, barcode TEXT, beforeValue TEXT, afterValue TEXT, time TEXT NOT NULL, PRIMARY KEY(task,id));`);
  const clients = new Set();
  const limits = new Map();
  function member(token) {
    const m = typeof token === 'string' && db.prepare('SELECT * FROM members WHERE token=?').get(hash(token));
    if (!m) fail('会话无效，请重新加入任务', 401);
    return m;
  }
  function snapshot(m) {
    const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(m.task);
    const orders = db.prepare('SELECT * FROM orders WHERE task=? ORDER BY updated DESC,barcode').all(m.task).map(o => ({barcode:o.barcode, actual:o.actual, estimate:o.estimate, hasFilledEstimate:!!o.filled, abnormal:!!o.abnormal, scanCount:o.scans, version:o.version, estimateVersion:o.estimateVersion, actualVersion:o.actualVersion, lastScanTime:o.updated}));
    return {task, me:{name:m.name,role:m.role}, orders,
      members:db.prepare('SELECT name,role FROM members WHERE task=?').all(m.task),
      logs:db.prepare('SELECT id,actor,kind,barcode,beforeValue,afterValue,time FROM operations WHERE task=? ORDER BY rowid DESC LIMIT 100').all(m.task)};
  }
  function broadcast(task) {
    for (const c of clients) if (c.m.task === task) c.res.write('data: '+JSON.stringify(snapshot(c.m))+'\n\n');
  }
  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      if(fs.existsSync(path.join(dataDir,'migration-lock.json'))) fail('正在迁移到 Google Sheets，暂停提交，请稍后使用原操作 ID 重试',503);
      const r=fn(); db.exec('COMMIT'); return r;
    } catch(e) { db.exec('ROLLBACK'); throw e; }
  }
  function operation(m,b) {
    if (!/^[a-zA-Z0-9-]{16,100}$/.test(b.id || '')) fail('操作 ID 无效');
    const payload=JSON.stringify([b.kind,b.barcode ?? null,b.value ?? null,b.expectedVersion ?? null,b.reason ?? null]);
    const result=transaction(() => {
      const prior=db.prepare('SELECT token,payload FROM operations WHERE task=? AND id=?').get(m.task,b.id);
      if(prior) { if(prior.token!==m.token || prior.payload!==payload) fail('操作 ID 已用于其他请求',409); return; }
      const task=db.prepare('SELECT * FROM tasks WHERE id=?').get(m.task);
      if(task.status!=='active') fail('任务已归档，不能继续修改',409);
      let before=null, after=null;
      if (b.kind==='archive') {
        if(m.role!=='admin') fail('仅任务创建人可以归档',403);
        before='active'; after='archived';
        db.prepare("UPDATE tasks SET status='archived',revision=revision+1 WHERE id=?").run(m.task);
      } else {
        if (!/^\d{8}$/.test(b.barcode||'')) fail('订单号必须为 8 位数字');
        if (!['scan','adjust','estimate','actual','abnormal'].includes(b.kind)) fail('操作类型无效');
        let o=db.prepare('SELECT * FROM orders WHERE task=? AND barcode=?').get(m.task,b.barcode);
        if(!o && b.kind!=='scan') fail('请先扫描该订单',404);
        if(!o) {
          db.prepare('INSERT INTO orders(task,barcode) VALUES(?,?)').run(m.task,b.barcode);
          o=db.prepare('SELECT * FROM orders WHERE task=? AND barcode=?').get(m.task,b.barcode);
        }
        before=JSON.stringify(o);
        if(b.kind==='scan') {
          db.prepare('UPDATE orders SET actual=actual+1,scans=scans+1,actualVersion=actualVersion+1 WHERE task=? AND barcode=?').run(m.task,b.barcode);
        } else if(b.kind==='adjust') {
          if (![1,-1].includes(b.value)) fail('调整量必须为 +1 或 -1');
          if(o.actual+b.value<0) fail('实际数量已为 0，无法再减');
          if(typeof b.reason!=='string' || !b.reason.trim() || b.reason.length>200) fail('请填写调整原因');
          db.prepare('UPDATE orders SET actual=actual+?,actualVersion=actualVersion+1 WHERE task=? AND barcode=?').run(b.value,m.task,b.barcode);
        } else if(['actual','estimate'].includes(b.kind)) {
          if(!Number.isSafeInteger(b.value) || b.value<0 || b.value>999999999) fail('数量须为 0～999999999 的整数');
          const version=b.kind==='actual'?o.actualVersion:o.estimateVersion;
          if(b.expectedVersion!==version) fail('其他成员已修改此数量，请关闭弹窗后重新打开确认',409);
          if(b.kind==='actual') {
            if(typeof b.reason!=='string' || !b.reason.trim() || b.reason.length>200) fail('请填写调整原因');
            db.prepare('UPDATE orders SET actual=?,actualVersion=actualVersion+1 WHERE task=? AND barcode=?').run(b.value,m.task,b.barcode);
          } else db.prepare('UPDATE orders SET estimate=?,filled=1,estimateVersion=estimateVersion+1 WHERE task=? AND barcode=?').run(b.value,m.task,b.barcode);
        } else db.prepare('UPDATE orders SET abnormal=1 WHERE task=? AND barcode=?').run(m.task,b.barcode);
        db.prepare('UPDATE tasks SET revision=revision+1 WHERE id=?').run(m.task);
        const rev=db.prepare('SELECT revision FROM tasks WHERE id=?').get(m.task).revision;
        db.prepare('UPDATE orders SET version=version+1,updated=? WHERE task=? AND barcode=?').run(rev,m.task,b.barcode);
        after=JSON.stringify(db.prepare('SELECT * FROM orders WHERE task=? AND barcode=?').get(m.task,b.barcode));
      }
      db.prepare('INSERT INTO operations(task,id,token,payload,actor,kind,barcode,beforeValue,afterValue,time) VALUES(?,?,?,?,?,?,?,?,?,?)').run(m.task,b.id,m.token,payload,m.name,b.kind,b.barcode??null,before,after,new Date().toISOString());
    });
    broadcast(m.task); return snapshot(m);
  }
  async function body(req) {
    let raw=''; for await(const chunk of req) { raw+=chunk; if(Buffer.byteLength(raw)>8192) fail('请求过大',413); }
    try { const b=JSON.parse(raw); if(!b || Array.isArray(b) || typeof b!=='object') fail('请求格式错误'); return b; } catch { fail('请求格式错误'); }
  }
  const send=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
  async function handler(req,res) {
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('X-Frame-Options','DENY');
    const url=new URL(req.url,'http://local');
    try {
      // API has no CORS allowance. Mutations require a same-origin browser request.
      if(req.method==='POST') {
        if(req.headers.origin && req.headers.origin!==`${req.socket.encrypted?'https':'http'}://${req.headers.host}`) fail('不允许跨站请求',403);
        const b=await body(req);
        if(['/api/create','/api/join'].includes(url.pathname)) {
          const ip=req.socket.remoteAddress, now=Date.now();
          if(limits.size>1000) for(const [k,v] of limits) if(now-v.start>60000) limits.delete(k);
          let l=limits.get(ip); if(!l || now-l.start>60000) {l={start:now,n:0};limits.set(ip,l);} if(++l.n>30) fail('操作过于频繁，请一分钟后再试',429);
          if(typeof b.name!=='string' || !b.name.trim() || b.name.length>40) fail('请填写姓名（不超过40字）');
          const token=random();
          let task;
          transaction(()=>{
            if(url.pathname==='/api/create') {
              if(typeof b.title!=='string' || !b.title.trim() || b.title.length>80) fail('请填写任务名称（不超过80字）');
              task={id:random(),code:randomBytes(8).toString('hex').toUpperCase(),title:b.title.trim()};
              db.prepare('INSERT INTO tasks(id,code,title) VALUES(?,?,?)').run(task.id,task.code,task.title);
            } else {
              task=db.prepare('SELECT * FROM tasks WHERE code=?').get(String(b.code||'').trim().toUpperCase());
              if(!task) fail('任务码不存在',404);
              if(task.status!=='active') fail('任务已归档，不能再加入',409);
            }
            db.prepare('INSERT INTO members(token,task,name,role) VALUES(?,?,?,?)').run(hash(token),task.id,b.name.trim(),url.pathname==='/api/create'?'admin':'member');
          });
          const m=member(token); send(res,200,{token,...snapshot(m)}); broadcast(m.task); return;
        }
        const m=member((req.headers.authorization||'').replace(/^Bearer /,''));
        if(url.pathname==='/api/op') { send(res,200,operation(m,b)); return; }
        fail('接口不存在',404);
      }
      if(req.method!=='GET') fail('不支持该请求',405);
      if(url.pathname==='/api/events') {
        // EventSource cannot set Authorization; use fetch streaming with the bearer header.
        const m=member((req.headers.authorization||'').replace(/^Bearer /,''));
        res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','Connection':'keep-alive','X-Accel-Buffering':'no'});
        res.write('data: '+JSON.stringify(snapshot(m))+'\n\n');
        const c={m,res}; clients.add(c);
        const timer=setInterval(()=>res.write(': heartbeat\n\n'),10000);
        res.on('close',()=>{clearInterval(timer);clients.delete(c);}); return;
      }
      if(url.pathname==='/api/state' || url.pathname==='/api/history') {
        const m=member((req.headers.authorization||'').replace(/^Bearer /,''));
        if(url.pathname==='/api/history') {
          send(res,200,{logs:db.prepare('SELECT actor,kind,barcode,payload,beforeValue,afterValue,time FROM operations WHERE task=? ORDER BY rowid').all(m.task)});
        } else send(res,200,snapshot(m)); return;
      }
      return serveWarehouseStatic(req,res,url);
    } catch(e) {
      if(!res.headersSent) send(res,e.status||500,{error:e.status?e.message:'服务器错误，请查看仓库电脑控制台'});
      if(!e.status) console.error(e);
    }
  }
  return {handler, close(){ for(const c of clients)c.res.end();db.close(); }};
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const dataDir=process.env.DATA_DIR||path.join(ROOT,'data');
  const sheetsConfigPath=path.join(dataDir,'google-sheets.json');
  const sheetsConfig=fs.existsSync(sheetsConfigPath)?JSON.parse(fs.readFileSync(sheetsConfigPath,'utf8').replace(/^\uFEFF/,'')):null;
  const app=sheetsConfig?.enabled===true?createGoogleSheetsBackend({config:sheetsConfig,serveStatic:serveWarehouseStatic}):createWarehouse({dataDir});
  if(sheetsConfig?.enabled===true&&fs.existsSync(path.join(dataDir,'migration-lock.json')))fs.unlinkSync(path.join(dataDir,'migration-lock.json'));
  console.log(sheetsConfig?.enabled===true?'数据后端：Google Sheets（需要联网，不自动回退到本地数据库）':'数据后端：本地 SQLite');
  const configPath=path.join(ROOT,'certs','https.json');
  const cfg=fs.existsSync(configPath)?JSON.parse(fs.readFileSync(configPath,'utf8').replace(/^\uFEFF/,'')):null;
  const listenHost=process.env.HOST||cfg?.ip||'0.0.0.0';
  const servers=[];
  const addresses=Object.values(networkInterfaces()).flat().filter(n=>n.family==='IPv4'&&!n.internal).map(n=>n.address);
  const port=Number(process.env.PORT||8080);
  const plain=http.createServer(app.handler); servers.push(plain);
  plain.listen(port,listenHost,()=>console.log(`扫码枪/证书下载：${(listenHost==='0.0.0.0'?['localhost',...addresses]:[listenHost]).map(a=>`http://${a}:${port}`).join('\n')}`));
  if(cfg) {
    const secure=https.createServer({pfx:fs.readFileSync(path.join(ROOT,'certs','server.pfx')),passphrase:cfg.passphrase},app.handler);servers.push(secure);
    const tlsPort=Number(process.env.HTTPS_PORT||8443);
    secure.listen(tlsPort,listenHost,()=>console.log(`手机摄像头/扫码枪：https://${cfg.ip}:${tlsPort}（手机先信任根证书）`));
  } else console.log('未配置 HTTPS：手机摄像头需先运行 setup-https.ps1，见 README。');
  for(const server of servers) server.on('error',e=>{console.error(e.message);process.exit(1);});
  function stop(){for(const s of servers)s.close();app.close();process.exit(0);}
  process.on('SIGINT',stop);process.on('SIGTERM',stop);
}
