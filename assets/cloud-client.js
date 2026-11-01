/* Google-hosted RPC transport. No local server, service secret, or credential in URLs. */
var CloudSheets=(()=>{
  const endpoint='https://script.google.com/macros/s/AKfycbwmACNvXvZ-LB3bkLnePbKxX3_Mq_63lA_1_dBHAQEgg0gItAXxi-eRjfKjv2dWA_7z/exec';
  const channel=Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join('');
  const pending=new Map();let peer=null,peerOrigin='',frame=null,readyResolve=null,readyReject=null,readyTimer=null,readyPromise=null;
  function connect(){
    if(readyPromise)return readyPromise;
    readyPromise=new Promise((resolve,reject)=>{
      readyResolve=resolve;readyReject=reject;
      readyTimer=setTimeout(()=>{readyPromise=null;frame?.remove();frame=null;peer=null;reject(new Error('无法连接 Google Sheets，请检查网络后重试'));},35000);
      frame=document.createElement('iframe');frame.hidden=true;frame.title='Google Sheets 数据连接';frame.referrerPolicy='no-referrer';frame.src=endpoint+'?channel='+channel;document.body.appendChild(frame);
    });return readyPromise;
  }
  window.addEventListener('message',event=>{
    const d=event.data;if(!d||d.channel!==channel)return;
    let host;try{host=new URL(event.origin).hostname;}catch{return;}
    if(event.origin!=='https://script.google.com'&&!host.endsWith('.googleusercontent.com'))return;
    if(d.type==='warehouse-ready'&&d.version===2){
      if(peer&&peer!==event.source)return;
      peer=event.source;peerOrigin=event.origin;clearTimeout(readyTimer);readyResolve?.();return;
    }
    if(event.source!==peer||event.origin!==peerOrigin||d.type!=='warehouse-response')return;
    const job=pending.get(d.id);if(!job)return;pending.delete(d.id);clearTimeout(job.timer);
    if(d.result?.ok)job.resolve(d.result.data);else job.reject(Object.assign(new Error(d.result?.error||'云端请求失败'),{status:d.result?.status||503}));
  });
  async function call(action,args={},token=''){
    await connect();
    return new Promise((resolve,reject)=>{
      const id=crypto.randomUUID();
      const timer=setTimeout(()=>{pending.delete(id);reject(new Error('云端响应超时，结果待确认，请用原编号重试'));},65000);
      pending.set(id,{resolve,reject,timer});peer.postMessage({type:'warehouse-request',channel,id,request:{action,args,token}},peerOrigin);
    });
  }
  return{call,ready:()=>call('ping'),newToken:()=>Array.from(crypto.getRandomValues(new Uint8Array(24)),b=>b.toString(16).padStart(2,'0')).join('')};
})();
