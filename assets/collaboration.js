/* Shared data lives on the warehouse server. This file integrates the original UI. */
var Coop = (() => {
  const KEY='warehouse-cloud-session-v1', PENDING='warehouse-cloud-pending-v1';
  let token='', state=null, connected=false, pending=null, busy=false, stopped=false, controller=null;
  let revision=-1, queue=Promise.resolve(), editVersions={}, uncertain=false;
  const $=id=>document.getElementById(id);
  const kinds={scan:'扫码 +1',adjust:'调整箱数',estimate:'设置预估',actual:'修改实际',abnormal:'标记异常',archive:'归档任务'};
  function uuid(){
    if(globalThis.crypto?.randomUUID) return crypto.randomUUID();
    // getRandomValues is also available on HTTP LAN pages; randomUUID may not be.
    const a=crypto.getRandomValues(new Uint8Array(24));return Array.from(a,x=>x.toString(16).padStart(2,'0')).join('');
  }
  function error(e){$('collabError').textContent=e.message||String(e);}
  function storage(key,value){try{localStorage.setItem(key,JSON.stringify(value));}catch{throw new Error('浏览器无法保存会话/待确认操作，请允许此网站存储后再试');}}
  function remove(key){try{localStorage.removeItem(key);}catch{}}
  async function api(url,data){
    const action={'/api/create':'create','/api/join':'join','/api/op':'op','/api/state':'state','/api/history':'history'}[url];
    if(!action)throw new Error('未知接口');
    return CloudSheets.call(action,data||{},token);
  }
  function controls(){
    const writable=connected && state?.task.status==='active' && !uncertain && !pending;
    $('scanPanel').classList.toggle('collab-disabled',!writable);
    $('tableBody').querySelectorAll('button').forEach(b=>b.disabled=!writable);
    $('clearAllBtn').disabled=!(writable&&state?.me.role==='admin');
    $('finishTaskBtn').disabled=!(writable&&state?.me.role==='admin');
    $('leaveTask').disabled=!!pending||busy;
    $('pendingBox').hidden=!pending;
    $('retryPending').disabled=!connected||busy;
    $('pendingText').textContent=pending?`有一笔「${kinds[pending.body.kind]} ${pending.body.barcode||''}」结果待确认。请勿重新扫描此箱；点击核对后会使用原操作 ID 重试。`:'';
    let label=!token?'未加入任务':!connected?'连接中断／正在连接，暂停提交':state?.task.status==='archived'?'任务已归档，可查看和导出':pending?'有操作待确认，暂停新提交':busy?'提交中，等待服务端确认':'已连接 Google Sheets · 自动同步';
    $('connectionState').textContent=label;
    $('connectionState').style.color=connected&&!pending?'#166534':'#b45309';
  }
  function apply(s){
    if(state?.task.id===s.task.id && s.task.revision<revision)return;
    state=s;revision=s.task.revision;
    boxData=new Map(s.orders.map(o=>[o.barcode,o]));
    renderTable();
    $('collabLobby').hidden=true;$('collabTask').hidden=false;
    $('taskTitle').textContent=s.task.title;
    $('taskCode').textContent=s.task.code;
    $('memberLabel').textContent=`${s.me.name} · ${s.me.role==='admin'?'管理员':'协作成员'} · 已加入 ${s.members.length} 人`;
    $('archiveTask').hidden=s.me.role!=='admin'||s.task.status!=='active';
    const logs=$('collabLogs');logs.replaceChildren();
    for(const l of s.logs){
      const row=document.createElement('div');row.className='collab-log';
      let detail='';
      try{const a=JSON.parse(l.afterValue),b=JSON.parse(l.beforeValue);if(a&&typeof a==='object')detail=`实际 ${b?.actual||0} → ${a.actual}；预估 ${a.filled?a.estimate:'待填写'}`;}catch{}
      row.textContent=`${new Date(l.time).toLocaleString()} · ${l.actor} · ${kinds[l.kind]||l.kind} ${l.barcode||''}\n${detail}`;logs.appendChild(row);
    }
    if(summaryOverlay.classList.contains('show'))onFinish();
    controls();
  }
  async function stream(){
    while(token&&!stopped){
      if(!busy){
        const own=token;
        try{const s=await api('/api/state');if(token===own){connected=true;apply(s);}}
        catch(e){connected=false;if(e.status===401){error(e);token='';remove(KEY);$('collabLobby').hidden=false;$('collabTask').hidden=true;}controls();}
      }
      await new Promise(r=>setTimeout(r,document.hidden?45000:15000));
    }
  }
  async function enter(create){
    if(pending)return error(new Error('请先确认当前待处理操作'));
    $('collabError').textContent='';
    const action=create?'create':'join',args={name:$('operatorName').value,title:$('newTaskTitle').value,code:$('joinCode').value};
    const buttons=[$('createTask'),$('joinTask')];buttons.forEach(b=>b.disabled=true);
    try{
      let attempt=JSON.parse(localStorage.getItem('warehouse-cloud-enter')||'null');
      if(attempt&&(attempt.action!==action||JSON.stringify(attempt.args)!==JSON.stringify(args)))throw new Error('上次加入结果待确认，请保持相同信息重试');
      if(!attempt){attempt={action,args,token:CloudSheets.newToken()};storage('warehouse-cloud-enter',attempt);}
      const s=await CloudSheets.call(attempt.action,attempt.args,attempt.token);
      storage(KEY,{token:s.token});remove('warehouse-cloud-enter');token=s.token;connected=true;revision=-1;apply(s);stream();
    }catch(e){if(e.status&&e.status<500)remove('warehouse-cloud-enter');error(e);}finally{buttons.forEach(b=>b.disabled=false);}
  }
  function ready(){
    if(!connected||!token){error(new Error('尚未连接 Google Sheets，未提交本次操作'));playErrorSound();return false;}
    if(state.task.status!=='active'){error(new Error('任务已归档，请创建或加入新任务'));return false;}
    if(pending||uncertain){error(new Error(uncertain?'先核对待确认操作，当前扫描未提交':'上一箱正在保存，本次扫描未提交，请等保存完成后重扫本箱'));playErrorSound();return false;}
    return true;
  }
  async function deliver(){
    if(!pending||busy)return false;
    busy=true;controls();
    try{
      const s=await api('/api/op',pending.body);
      pending=null;remove(PENDING);uncertain=false;apply(s);$('collabError').textContent='';return true;
    }catch(e){
      if(e.status && e.status<500){pending=null;remove(PENDING);uncertain=false;error(e);try{apply(await api('/api/state'));}catch{}}
      else{uncertain=true;error(new Error('连接中断或响应超时，结果待确认。不要重新扫描此箱；恢复后点击“核对并重试”。'));}
      return false;
    }finally{busy=false;controls();}
  }
  function submit(fields,after){
    if(!ready())return Promise.resolve(false);
    const task=state.task.id;
    const body={id:uuid(),...fields};
    queue=queue.then(async()=>{
      if(!ready()||state.task.id!==task)return false;
      pending={token,body};
      try{storage(PENDING,pending);}catch(e){pending=null;error(e);controls();return false;}
      controls();const ok=await deliver();if(ok&&after)after();return ok;
    }).catch(e=>{error(e);return false;});
    return queue;
  }
  function add(barcode,source){
    const code=String(barcode||'').trim();
    if(!/^\d{8}$/.test(code)){setStatusMessage('订单号必须恰好为 8 位数字',true);playErrorSound();return false;}
    if([modalOverlay,orderModalOverlay,summaryOverlay,warnModalOverlay,locateInputModalOverlay,locateModalOverlay].some(x=>x.classList.contains('show')))return false;
    if(!ready())return false;
    submit({kind:'scan',barcode:code},()=>{
      const o=boxData.get(code);
      setStatusMessage(`已保存 | ${code} → 共享实际 ${o.actual} 箱${o.hasFilledEstimate?'':'；请点击“预估”填写总数'}`,false);
      playScanHitSound();if(navigator.vibrate)navigator.vibrate(60);
      checkLocateHit(code);
      if(source==='camera'){updateCameraLast({ok:true,code});cameraLast.appendChild(document.createTextNode(' · 已保存'));}
      if(o.hasFilledEstimate&&o.actual>o.estimate&&source!=='camera')triggerOverWarn(code,o.actual,o.estimate);
    });
    return true;
  }
  function adjust(e){
    if(!ready())return;
    const barcode=e.currentTarget.getAttribute('data-barcode'),plus=e.currentTarget.getAttribute('data-action')==='plus';
    const reason=prompt('请输入调整原因（此操作会记录操作人）：',plus?'补录一箱':'撤销误扫一箱');
    if(!reason?.trim())return;
    submit({kind:'adjust',barcode,value:plus?1:-1,reason:reason.trim()},()=>setStatusMessage('调整已保存',false));
  }
  function capture(o){editVersions={actual:o?.actualVersion||0,estimate:o?.estimateVersion||0};}
  async function confirmInput(){
    if(!currentBarcode||!ready())return;
    if(!/^\d{1,9}$/.test(modalInputValue)){setStatusMessage('请输入 0～999999999 的整数',true);return;}
    const actual=modalMode==='actual',barcode=currentBarcode;
    let reason;if(actual){reason=prompt('修改实际总数的原因：');if(!reason?.trim())return;}
    const button=modalConfirmBtn;button.disabled=true;
    try{const ok=await submit({kind:actual?'actual':'estimate',barcode,value:Number(modalInputValue),expectedVersion:editVersions[actual?'actual':'estimate'],...(actual?{reason:reason.trim()}: {})});if(ok){closeModal();setStatusMessage('数量已保存并同步',false);playConfirmSound();}}
    finally{button.disabled=false;}
  }
  async function archive(){
    if(!ready())return;
    if(state.me.role!=='admin')return error(new Error('仅管理员可结束任务'));
    if(!confirm('确认结束并归档整个共享任务？所有成员将停止扫码，历史记录保留，可继续导出。'))return;
    await submit({kind:'archive'},()=>{closeSummary();setStatusMessage('任务已归档，数据已保留',false);});
  }
  function mark(){const bc=currentWarnBarcode;if(!bc)return;submit({kind:'abnormal',barcode:bc},()=>{closeWarnModal();setStatusMessage('异常标记已同步',false);});}
  async function history(){
    try{const b=await api('/api/history');const blob=new Blob([JSON.stringify(b.logs,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='操作记录_'+state.task.code+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);}catch(e){error(e);}
  }
  function boot(){
    clearAllBtn.textContent='结束并归档任务';finishTaskBtn.textContent='结束并归档任务';
    $('createTask').onclick=()=>enter(true);$('joinTask').onclick=()=>enter(false);
    $('retryPending').onclick=()=>{queue=queue.then(()=>deliver());};
    $('archiveTask').onclick=archive;$('downloadHistory').onclick=history;
    $('leaveTask').onclick=()=>{
      if(pending||busy)return;
      if(!confirm('退出当前任务？共享数据会保留。管理员退出前请保留当前浏览器会话；清除会话后无法用任务码恢复管理员权限。'))return;
      stopped=true;controller?.abort();token='';remove(KEY);location.reload();
    };
    $('copyTask').onclick=async()=>{try{await navigator.clipboard.writeText(state.task.code);$('collabError').textContent='任务码已复制';}catch{prompt('复制任务码：',state.task.code);}};
    if(!window.isSecureContext)$('httpsHint').hidden=false;
    try{const s=JSON.parse(localStorage.getItem(KEY)||'null');if(s?.token)token=s.token;pending=JSON.parse(localStorage.getItem(PENDING)||'null');if(pending && pending.token!==token)throw new Error('待确认操作所属会话不一致，请勿清除浏览器数据，并联系管理员核对记录');uncertain=!!pending;}catch(e){error(e);}
    try{const entering=JSON.parse(localStorage.getItem('warehouse-cloud-enter')||'null');if(entering&&!token){$('operatorName').value=entering.args.name;$('newTaskTitle').value=entering.args.title;$('joinCode').value=entering.args.code;error(new Error('上次加入结果待确认，请点击原来的创建/加入按钮重试'));}}catch{}
    controls();if(token)stream();else CloudSheets.ready().then(()=>$('connectionState').textContent='Google Sheets 已连接，请创建或加入任务').catch(error);
    document.addEventListener('visibilitychange',()=>{if(!document.hidden&&token)api('/api/state').then(apply).catch(()=>{});});
    window.addEventListener('beforeunload',e=>{if(pending||busy){e.preventDefault();e.returnValue='';}});
  }
  return {boot,add,adjust,capture,confirmInput,archive,mark,ready};
})();
