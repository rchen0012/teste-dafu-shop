import { randomBytes, createHmac } from 'node:crypto';

export function validateConfig(config) {
  let url;try{url=new URL(config.endpoint);}catch{throw new Error('Google Apps Script 服务地址无效');}
  if(url.protocol!=='https:'||url.hostname!=='script.google.com'||!/^\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url.pathname)||url.search||url.hash)throw new Error('地址必须是 https://script.google.com/macros/s/部署ID/exec');
  if(typeof config.secret!=='string'||config.secret.length<32)throw new Error('Google Sheets 服务密钥至少32字符');
}
export async function callSheets(config,action,args={},token='',fetcher=fetch){
  validateConfig(config);
  const payload=JSON.stringify({timestamp:Date.now(),nonce:randomBytes(12).toString('hex'),action,args,token});
  const signature=createHmac('sha256',config.secret).update(payload).digest('hex');
  try{
    const r=await fetcher(config.endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({payload,signature}),signal:AbortSignal.timeout(55000),redirect:'follow'});
    if(!r.ok)throw new Error('Google 服务不可用');
    const b=await r.json();
    if(!b.ok)throw Object.assign(new Error(b.error||'Google Sheets 请求失败'),{status:b.status||503});
    return b.data;
  }catch(e){
    if(e.status)throw e;
    throw Object.assign(new Error('Google Sheets 连接中断，操作结果待确认，请使用原操作 ID 重试'),{status:503});
  }
}
export function createGoogleSheetsBackend({config,serveStatic,fetcher=fetch,pollMs=10000}){
  validateConfig(config);
  const clients=new Set(),limits=new Map();let closed=false,polling=false;
  const rpc=(action,args,token)=>callSheets(config,action,args,token,fetcher);
  const send=(res,status,b)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(b));};
  function publish(s){for(const c of clients)if(c.task===s.task.id&&s.task.revision>=c.revision){c.revision=s.task.revision;c.res.write('data: '+JSON.stringify({...s,me:c.me})+'\n\n');}}
  async function read(req){let s='';for await(const part of req){s+=part;if(Buffer.byteLength(s)>8192)throw Object.assign(new Error('请求过大'),{status:413});}try{const b=JSON.parse(s);if(!b||Array.isArray(b)||typeof b!=='object')throw new Error();return b;}catch{throw Object.assign(new Error('请求格式错误'),{status:400});}}
  const timer=setInterval(async()=>{
    if(closed||polling||!clients.size)return;polling=true;
    try{
      const tasks=new Map();for(const c of clients)if(!tasks.has(c.task))tasks.set(c.task,c);
      // One cloud poll per task, shared by all subscribers. No per-phone polling fanout.
      for(const c of tasks.values()){
        try{publish(await rpc('state',{},c.token));}
        catch{for(const peer of clients)if(peer.task===c.task)peer.res.end();}
      }
    }finally{polling=false;}
  },pollMs);timer.unref();
  return{
    async handler(req,res){
      res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');
      const url=new URL(req.url,'http://local');
      if(!url.pathname.startsWith('/api/'))return serveStatic(req,res,url);
      const token=(req.headers.authorization||'').replace(/^Bearer /,'');
      try{
        if(req.method==='POST'){
          if(req.headers.origin&&req.headers.origin!==`${req.socket.encrypted?'https':'http'}://${req.headers.host}`)throw Object.assign(new Error('不允许跨站请求'),{status:403});
          const b=await read(req);
          if(url.pathname==='/api/create'||url.pathname==='/api/join'){
            const ip=req.socket.remoteAddress,now=Date.now();
            if(limits.size>1000)for(const [key,v] of limits)if(now-v.at>60000)limits.delete(key);
            let limit=limits.get(ip);if(!limit||now-limit.at>60000){limit={at:now,n:0};limits.set(ip,limit);}
            if(++limit.n>30)throw Object.assign(new Error('操作过于频繁，请一分钟后再试'),{status:429});
            const freshToken=randomBytes(24).toString('hex');
            const s=await rpc(url.pathname==='/api/create'?'create':'join',{...b,taskId:randomBytes(24).toString('hex'),...(url.pathname==='/api/create'?{code:randomBytes(8).toString('hex').toUpperCase()}: {})},freshToken);
            publish(s);return send(res,200,s);
          }
          if(url.pathname==='/api/op'){const s=await rpc('op',b,token);publish(s);return send(res,200,s);}
        }else if(req.method==='GET'){
          if(url.pathname==='/api/state')return send(res,200,await rpc('state',{},token));
          if(url.pathname==='/api/history')return send(res,200,await rpc('history',{},token));
          if(url.pathname==='/api/events'){
            const s=await rpc('state',{},token);
            if(res.destroyed)return;
            res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','Connection':'keep-alive'});
            res.write('data: '+JSON.stringify(s)+'\n\n');
            const c={res,token,task:s.task.id,me:s.me,revision:s.task.revision};clients.add(c);
            // No heartbeat on failed cloud polling: end stream to make the client pause submissions.
            res.on('close',()=>clients.delete(c));return;
          }
        }
        send(res,404,{error:'接口不存在'});
      }catch(e){if(!res.headersSent)send(res,e.status||503,{error:e.message});else res.end();}
    },
    close(){closed=true;clearInterval(timer);for(const c of clients)c.res.end();}
  };
}
