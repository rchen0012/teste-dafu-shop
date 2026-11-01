import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { callSheets,validateConfig } from './backend.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dataDir=path.join(root,'data');
fs.mkdirSync(dataDir,{recursive:true});
let input='';for await(const chunk of process.stdin){input+=chunk;if(input.length>10000)throw new Error('配置输入过大');}
const cfg=JSON.parse(input.replace(/^\uFEFF/,''));validateConfig(cfg);
const configPath=path.join(dataDir,'google-sheets.json');
if(fs.existsSync(configPath)&&JSON.parse(fs.readFileSync(configPath,'utf8').replace(/^\uFEFF/,'')).enabled)throw new Error('Google Sheets 已启用，请勿重复迁移');
await callSheets(cfg,'health');
const lock=path.join(dataDir,'migration-lock.json');
const sqlite=path.join(dataDir,'warehouse.sqlite');
let source={tasks:[],members:[],orders:[],operations:[]};
if(fs.existsSync(sqlite)){
  const db=new DatabaseSync(sqlite);db.exec('PRAGMA busy_timeout=10000; BEGIN IMMEDIATE');
  try{
    // Freeze local mutations under the same SQLite write lock before taking the migration snapshot.
    fs.writeFileSync(lock,JSON.stringify({started:new Date().toISOString(),destination:'Google Sheets'}));
    for(const table of Object.keys(source))source[table]=db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
    db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}finally{db.close();}
}else fs.writeFileSync(lock,JSON.stringify({started:new Date().toISOString(),destination:'Google Sheets'}));
const backup=path.join(dataDir,'before-google-sheets.json');
// Never replace the migration snapshot on a retry after an uncertain network result.
if(fs.existsSync(backup))source=JSON.parse(fs.readFileSync(backup,'utf8'));else fs.writeFileSync(backup,JSON.stringify(source));
if(Buffer.byteLength(JSON.stringify(source))>1500000)throw new Error('历史数据超过本迁移工具单批限制，请先联系管理员分批迁移；本地已暂停提交，未切换后端');
try{
  const result=await callSheets(cfg,'import',source);
  for(const [key,rows] of Object.entries(source))if(result.imported[key]!==rows.length)throw new Error('迁移行数不一致：'+key);
  fs.writeFileSync(configPath,JSON.stringify({...cfg,enabled:true,migratedAt:new Date().toISOString()},null,2),{mode:0o600});
  console.log('迁移核对完成：'+Object.entries(result.imported).map(([k,n])=>`${k}=${n}`).join(', '));
  console.log('请重启仓库服务。新服务启动后以 Google Sheets 为唯一后端，并解除本地提交暂停。原 SQLite 和迁移前快照已保留。');
}catch(e){
  console.error('迁移未确认完成，本地仍暂停提交，原数据保留。修复配置或网络后重跑连接脚本，不要删除迁移锁或手动重扫。');
  console.error(e.message);process.exitCode=1;
}
