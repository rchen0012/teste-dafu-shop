/** Google Apps Script V8. Enable advanced Google Sheets API (see appsscript.json). */
var TABLES = {
  tasks:{sheet:'任务',keys:['id','code','title','status','revision'],headers:['任务ID','任务码','任务名称','状态','版本']},
  members:{sheet:'成员',keys:['token','task','name','role'],headers:['会话哈希','任务ID','姓名','角色']},
  orders:{sheet:'订单',keys:['task','barcode','actual','estimate','filled','abnormal','scans','version','estimateVersion','actualVersion','updated'],headers:['任务ID','订单号','实际箱数','预估箱数','已填预估','异常标记','扫码次数','版本','预估版本','实际版本','更新时间序号']},
  operations:{sheet:'操作记录',keys:['task','id','token','payload','actor','kind','barcode','beforeValue','afterValue','time'],headers:['任务ID','操作ID','会话哈希','请求内容','操作人','操作类型','订单号','修改前','修改后','操作时间']}
};
function reject_(message,status){throw Object.assign(new Error(message),{status:status||400});}
function sha_(s){return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,s,Utilities.Charset.UTF_8).map(function(b){return('0'+((b+256)%256).toString(16)).slice(-2);}).join('');}
function tableRows_(t){return t.rows.map(function(x){return x.value;});}
function lookup_(t,predicate){return t.rows.find(function(x){return predicate(x.value);});}

// Stable 8-digit aliases let older 16-character task codes continue to work.
function taskCodes_(tables){
 var rows=tableRows_(tables.tasks),used={},out={};
 rows.forEach(function(t){if(/^\d{8}$/.test(String(t.code))){used[t.code]=true;out[t.id]=String(t.code);}});
 rows.slice().sort(function(a,b){return String(a.id).localeCompare(String(b.id));}).forEach(function(t){if(out[t.id])return;for(var n=0;n<1000;n++){var code=String(parseInt(sha_(t.id+':short:'+n).slice(0,12),16)%100000000).padStart(8,'0');if(!used[code]){out[t.id]=code;used[code]=true;break;}}if(!out[t.id])reject_('任务码繁忙，请稍后重试',503);});
 return out;
}

function publicSnapshot_(tables,m){
  var task=lookup_(tables.tasks,function(t){return t.id===m.task;});
  if(!task)reject_('任务不存在',404);
  var logs=tableRows_(tables.operations).filter(function(o){return o.task===m.task;}).slice(-100).reverse();
  return {task:Object.assign({},task.value,{code:taskCodes_(tables)[m.task]}),me:{name:m.name,role:m.role},
    members:tableRows_(tables.members).filter(function(x){return x.task===m.task;}).map(function(x){return{name:x.name,role:x.role};}),
    orders:tableRows_(tables.orders).filter(function(o){return o.task===m.task;}).map(function(o){return{barcode:o.barcode,actual:o.actual,estimate:o.estimate,hasFilledEstimate:!!o.filled,abnormal:!!o.abnormal,scanCount:o.scans,version:o.version,estimateVersion:o.estimateVersion,actualVersion:o.actualVersion,lastScanTime:o.updated,done:(function(){var marks=tableRows_(tables.operations).filter(function(l){return l.task===m.task&&l.barcode===o.barcode&&l.kind==='done';});if(!marks.length)return false;try{return !!JSON.parse(marks[marks.length-1].afterValue).done;}catch(e){return false;}})()};}),
    logs:logs.map(function(o){return{id:o.id,actor:o.actor,kind:o.kind,barcode:o.barcode,beforeValue:o.beforeValue,afterValue:o.afterValue,time:o.time};})};
}
/** Pure planning: all table changes are committed together by one atomic batchUpdate. */
function plan_(tables,action,args,token){
  var changes=[];
  function add(table,value){var row=tables[table].rows.reduce(function(n,r){return Math.max(n,r.row+1);},1);var record={row:row,value:value};tables[table].rows.push(record);changes.push({table:table,row:row,value:value});return record;}
  function update(table,r){changes.push({table:table,row:r.row,value:r.value});}
  if(action==='create'||action==='join'){
    if(typeof args.name!=='string'||!args.name.trim()||args.name.length>40)reject_('请填写姓名（不超过40字）');
    if(!/^[a-f0-9]{48}$/.test(token||''))reject_('会话格式错误');
    var existing=lookup_(tables.members,function(m){return m.token===sha_(token);});
    if(existing)return{changes:[],data:{token:token,...publicSnapshot_(tables,existing.value)}};
    var t;
    if(action==='create'){
      if(typeof args.title!=='string'||!args.title.trim()||args.title.length>80)reject_('请填写任务名称（不超过80字）');
      if(typeof args.taskId!=='string'||typeof args.code!=='string')reject_('任务参数错误');
      if(lookup_(tables.tasks,function(x){return x.id===args.taskId||x.code===args.code;}))reject_('任务标识冲突，请重试',409);
      t=add('tasks',{id:args.taskId,code:args.code,title:args.title.trim(),status:'active',revision:0}).value;
    }else{
      var found=lookup_(tables.tasks,function(x){return x.code===String(args.code||'').trim().toUpperCase()||taskCodes_(tables)[x.id]===String(args.code||'').trim();});
      if(!found)reject_('任务码不存在',404);t=found.value;if(t.status!=='active')reject_('任务已归档',409);
    }
    var m=add('members',{token:sha_(token),task:t.id,name:args.name.trim(),role:action==='create'?'admin':'member'}).value;
    return{changes:changes,data:{token:token,...publicSnapshot_(tables,m)}};
  }
  var member=lookup_(tables.members,function(m){return m.token===sha_(token||'');});
  if(!member)reject_('会话无效，请重新加入任务',401);
  var m=member.value;
  if(action==='state')return{changes:[],data:publicSnapshot_(tables,m)};
  if(action==='history')return{changes:[],data:{logs:tableRows_(tables.operations).filter(function(o){return o.task===m.task;}).map(function(o){return{id:o.id,clientTime:(function(){try{return JSON.parse(o.payload)[5]||'';}catch(e){return '';}})(),actor:o.actor,kind:o.kind,barcode:o.barcode,payload:o.payload,beforeValue:o.beforeValue,afterValue:o.afterValue,time:o.time};})}};
  if(action!=='op')reject_('未知接口',404);
  var b=args;
  if(b.clientTime!==undefined&&(typeof b.clientTime!=='string'||!Number.isFinite(Date.parse(b.clientTime))))reject_('扫码时间格式无效');
  if(!/^[a-zA-Z0-9-]{16,100}$/.test(b.id||''))reject_('操作 ID 无效');
  var payload=JSON.stringify([b.kind,b.barcode??null,b.value??null,b.expectedVersion??null,b.reason??null].concat(b.clientTime?[b.clientTime]:[]));
  var prior=lookup_(tables.operations,function(o){return o.task===m.task&&o.id===b.id;});
  if(prior){if(prior.value.token!==m.token||prior.value.payload!==payload)reject_('操作 ID 已用于其他请求',409);return{changes:[],data:publicSnapshot_(tables,m)};}
  var task=lookup_(tables.tasks,function(t){return t.id===m.task;});
  if(task&&task.value.status==='archived'&&b.kind==='archive'){if(m.role!=='admin')reject_('仅任务创建人可以归档',403);return{changes:[],data:publicSnapshot_(tables,m)};}
  if(!task||task.value.status!=='active')reject_('任务已归档，不能继续修改',409);
  var before=null,after=null;
  if(b.kind==='archive'){
    if(m.role!=='admin')reject_('仅任务创建人可以归档',403);
    before='active';after='archived';task.value.status='archived';
  }else{
    if(!/^\d{8}$/.test(b.barcode||''))reject_('订单号必须为 8 位数字');
    if(!['scan','adjust','estimate','actual','abnormal','done'].includes(b.kind))reject_('操作类型无效');
    var record=lookup_(tables.orders,function(o){return o.task===m.task&&o.barcode===b.barcode;});
    if(!record&&b.kind!=='scan')reject_('请先扫描该订单',404);
    if(!record)record=add('orders',{task:m.task,barcode:b.barcode,actual:0,estimate:0,filled:0,abnormal:0,scans:0,version:0,estimateVersion:0,actualVersion:0,updated:0});
    var o=record.value;before=JSON.stringify(o);
    if(b.kind==='scan'){o.actual++;o.scans++;o.actualVersion++;}
    else if(b.kind==='adjust'){
      if(!Number.isSafeInteger(b.value)||b.value===0||Math.abs(b.value)>99999)reject_('调整量必须为非零整数，绝对值不超过99999');
      if(typeof b.reason!=='string'||!b.reason.trim()||b.reason.length>200)reject_('请填写调整原因');
      o.actual+=b.value;o.actualVersion++;
    }else if(b.kind==='actual'||b.kind==='estimate'){
      if(!Number.isSafeInteger(b.value)||b.value<0||b.value>999999999)reject_('数量须为 0～999999999 的整数');
      var field=b.kind==='actual'?'actualVersion':'estimateVersion';
      if(b.expectedVersion!==o[field])reject_('其他成员已修改此数量，请关闭弹窗后重新打开确认',409);
      if(b.kind==='actual'){
        if(typeof b.reason!=='string'||!b.reason.trim()||b.reason.length>200)reject_('请填写调整原因');
        o.actual=b.value;
      }else{o.estimate=b.value;o.filled=1;}
      o[field]++;
    }else if(b.kind==='done'){if(![0,1].includes(b.value))reject_('完成标记无效');o.done=b.value;}else {if(b.value!==undefined&&![0,1].includes(b.value))reject_('异常标记无效');o.abnormal=b.value===undefined?1:b.value;}
    if(o.actual<0||o.actual>999999999)reject_('实际数量超出允许范围');
    o.version++;o.updated=task.value.revision+1;after=JSON.stringify(o);update('orders',record);
  }
  task.value.revision++;update('tasks',task);
  add('operations',{task:m.task,id:b.id,token:m.token,payload:payload,actor:m.name,kind:b.kind,barcode:b.barcode||'',beforeValue:before||'',afterValue:after||'',time:new Date().toISOString()});
  return{changes:changes,data:publicSnapshot_(tables,m)};
}
function readTables_(id,ids){
  var names=Object.keys(TABLES),ranges=names.map(function(k){return "'"+TABLES[k].sheet+"'!A2:"+String.fromCharCode(64+TABLES[k].keys.length);});
  var result=Sheets.Spreadsheets.Values.batchGet(id,{ranges:ranges,valueRenderOption:'UNFORMATTED_VALUE',dateTimeRenderOption:'FORMATTED_STRING'});
  var out={};names.forEach(function(k,i){var def=TABLES[k];out[k]={id:ids[k],rows:(result.valueRanges[i].values||[]).map(function(v,index){var o={};def.keys.forEach(function(key,c){o[key]=v[c]??'';});return{row:index+1,value:o};}).filter(function(r){return r.value[def.keys[0]]!=='';})};});return out;
}
function toCell_(v){return{userEnteredValue:typeof v==='number'?{numberValue:v}:typeof v==='boolean'?{boolValue:v}:{stringValue:String(v??'')}};}
function commit_(id,tables,changes){
  if(!changes.length)return;
  var unique={};changes.forEach(function(c){unique[c.table+':'+c.row]=c;});
  var requests=[],needed={};
  Object.keys(unique).forEach(function(k){var c=unique[k];needed[c.table]=Math.max(needed[c.table]||0,c.row+1);});
  // appendDimension adds spare rows only, so sparse/large migrations never exceed grid bounds.
  var meta=Sheets.Spreadsheets.get(id,{fields:'sheets(properties(sheetId,gridProperties(rowCount)))'});
  var sizes={};meta.sheets.forEach(function(s){sizes[s.properties.sheetId]=s.properties.gridProperties.rowCount;});
  Object.keys(needed).forEach(function(k){var missing=needed[k]-sizes[tables[k].id];if(missing>0)requests.push({appendDimension:{sheetId:tables[k].id,dimension:'ROWS',length:missing}});});
  Object.keys(unique).forEach(function(k){var c=unique[k];requests.push({updateCells:{start:{sheetId:tables[c.table].id,rowIndex:c.row,columnIndex:0},rows:[{values:TABLES[c.table].keys.map(function(key){return toCell_(c.value[key]);})}],fields:'userEnteredValue'}});});
  // Google Sheets validates the complete batch and applies it atomically: order + audit + task version.
  Sheets.Spreadsheets.batchUpdate({requests:requests},id);
}
function setupWarehouse(){
  var props=PropertiesService.getScriptProperties();
  if(!props.getProperty('SPREADSHEET_ID')){
    var bound=SpreadsheetApp.getActiveSpreadsheet();
    if(!bound)throw new Error('此脚本需要绑定到仓库表格，或先设置 SPREADSHEET_ID');
    props.setProperty('SPREADSHEET_ID',bound.getId());
  }
  // Generate a credential inside the user's own project. Never log it or place it in a sheet.
  if(!props.getProperty('WAREHOUSE_SECRET'))props.setProperty('WAREHOUSE_SECRET',Utilities.getUuid().replace(/-/g,'')+Utilities.getUuid().replace(/-/g,''));
  initializeWarehouse();
}
function initializeWarehouse(){
  var props=PropertiesService.getScriptProperties(),id=props.getProperty('SPREADSHEET_ID');
  if(!id||!props.getProperty('WAREHOUSE_SECRET')||props.getProperty('WAREHOUSE_SECRET').length<32)throw new Error('先设置 SPREADSHEET_ID 和至少32字符的 WAREHOUSE_SECRET');
  var ss=SpreadsheetApp.openById(id),ids={};
  Object.keys(TABLES).forEach(function(k){var def=TABLES[k],sheet=ss.getSheetByName(def.sheet);if(!sheet)throw new Error('缺少数据表 '+def.sheet);var header=sheet.getRange(1,1,1,def.keys.length).getValues()[0];if(JSON.stringify(header)!==JSON.stringify(def.headers))throw new Error('表头不匹配 '+def.sheet);ids[k]=sheet.getSheetId();sheet.setFrozenRows(1);});
  // Order IDs and token hashes are literal strings; never interpret leading zeros as numbers.
  ss.getSheetByName('订单').getRange('B:B').setNumberFormat('@');
  ss.getSheetByName('操作记录').getRange('G:G').setNumberFormat('@');
  props.setProperty('SHEET_IDS',JSON.stringify(ids));
  console.log('已验证表结构。请勿直接编辑数据表、排序数据区或删除操作记录。');
}
function doPost(e){
  var lock;
  try{
    var props=PropertiesService.getScriptProperties(),secret=props.getProperty('WAREHOUSE_SECRET');
    if(!secret)reject_('尚未配置服务',503);
    var envelope=JSON.parse(e.postData.contents);
    if(typeof envelope.payload!=='string'||typeof envelope.signature!=='string')reject_('未授权',401);
    var expected=Utilities.computeHmacSha256Signature(envelope.payload,secret,Utilities.Charset.UTF_8).map(function(b){return('0'+((b+256)%256).toString(16)).slice(-2);}).join('');
    var diff=expected.length^envelope.signature.length;for(var i=0;i<expected.length;i++)diff|=expected.charCodeAt(i)^(envelope.signature.charCodeAt(i)||0);
    if(diff)reject_('签名无效',401);
    var request=JSON.parse(envelope.payload);
    if(!Number.isFinite(request.timestamp)||Math.abs(Date.now()-request.timestamp)>300000)reject_('请求已过期',401);
    lock=LockService.getScriptLock();if(!lock.tryLock(20000))reject_('Google Sheets 正忙，请使用原操作 ID 重试',503);
    var id=props.getProperty('SPREADSHEET_ID'),ids=JSON.parse(props.getProperty('SHEET_IDS')||'null');
    if(!id||!ids)reject_('请先运行 initializeWarehouse',503);
    var tables=readTables_(id,ids);
    if(request.action==='health')return json_({ok:true,data:{ready:true,counts:Object.fromEntries(Object.keys(TABLES).map(function(k){return[k,tables[k].rows.length];}))}});
    if(request.action==='import'){
      var source=request.args;
      // Single atomic import into an empty destination; original local database is not removed.
      if(Object.keys(TABLES).some(function(k){return tables[k].rows.length;})){
        var equal=Object.keys(TABLES).every(function(k){var keys=TABLES[k].keys;if(!Array.isArray(source[k])||source[k].length!==tables[k].rows.length)return false;return source[k].every(function(value,i){return keys.every(function(key){return(value[key]??'')===(tables[k].rows[i].value[key]??'');});});});
        if(!equal)reject_('目标表已有不同数据，停止迁移，避免覆盖',409);
        return json_({ok:true,data:{imported:Object.fromEntries(Object.keys(TABLES).map(function(k){return[k,source[k].length];})),duplicate:true}});
      }
      var changes=[];
      Object.keys(TABLES).forEach(function(k){if(!Array.isArray(source[k]))reject_('迁移数据格式错误');source[k].forEach(function(value,index){changes.push({table:k,row:index+1,value:value});});});
      commit_(id,tables,changes);
      return json_({ok:true,data:{imported:Object.fromEntries(Object.keys(TABLES).map(function(k){return[k,source[k].length];}))}});
    }
    var result=plan_(tables,request.action,request.args||{},request.token);
    commit_(id,tables,result.changes);
    return json_({ok:true,data:result.data});
  }catch(error){return json_({ok:false,status:error.status||503,error:error.status?error.message:'Google Sheets 处理失败，结果待确认，请使用原操作 ID 重试'});}
  finally{if(lock&&lock.hasLock())lock.releaseLock();}
}
function json_(value){return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);}

// Browser transport. Membership tokens protect task data; privileged import/health stay HMAC-only.

/** Owner-only setup: enter RESET_PASSWORD_SETUP in Script Properties, then run this function. */
function configureResetPassword(){
 var p=PropertiesService.getScriptProperties(),password=p.getProperty('RESET_PASSWORD_SETUP'),secret=p.getProperty('WAREHOUSE_SECRET');
 if(typeof password!=='string'||password.length<8||password.length>128)throw new Error('请先在脚本属性设置 RESET_PASSWORD_SETUP（8～128位），不要在日志或代码中填写密码');
 if(!secret)throw new Error('仓库服务尚未初始化');
 var salt=Utilities.getUuid();p.setProperty('RESET_PASSWORD_SALT',salt);p.setProperty('RESET_PASSWORD_HASH',resetHash_(password,salt,secret));
 p.deleteProperty('RESET_PASSWORD_SETUP');p.deleteProperty('RESET_FAILURES');p.deleteProperty('RESET_FAILURE_WINDOW');console.log('管理员清除密码已设置，临时明文属性已移除。');
}
function resetHash_(password,salt,secret){return Utilities.computeHmacSha256Signature(salt+':'+password,secret,Utilities.Charset.UTF_8).map(function(b){return('0'+((b+256)%256).toString(16)).slice(-2);}).join('');}
function verifyResetPassword_(password){
 var p=PropertiesService.getScriptProperties(),expected=p.getProperty('RESET_PASSWORD_HASH'),salt=p.getProperty('RESET_PASSWORD_SALT');
 if(!expected||!salt)reject_('管理员尚未设置清除密码，请先完成密码设置',409);
 var windowStart=Number(p.getProperty('RESET_FAILURE_WINDOW')||0),failures=Number(p.getProperty('RESET_FAILURES')||0);
 if(Date.now()-windowStart>=900000){windowStart=Date.now();failures=0;p.setProperty('RESET_FAILURE_WINDOW',String(windowStart));}
 if(failures>=5)reject_('密码尝试过多，请15分钟后重试',429);
 var actual=resetHash_(typeof password==='string'?password:'',salt,p.getProperty('WAREHOUSE_SECRET')),diff=actual.length^expected.length;
 for(var i=0;i<expected.length;i++)diff|=expected.charCodeAt(i)^(actual.charCodeAt(i)||0);
 if(diff){p.setProperty('RESET_FAILURES',String(failures+1));reject_('管理员密码错误，未清除任何数据',403);}
 p.deleteProperty('RESET_FAILURES');p.deleteProperty('RESET_FAILURE_WINDOW');
}
function resetAll_(id,tables,args,token){
 if(!/^[a-zA-Z0-9-]{16,100}$/.test(args.id||'')||args.confirm!=='123456')reject_('请输入完整确认数字“123456”');
 verifyResetPassword_(args.password);
 var meta=Sheets.Spreadsheets.get(id,{fields:'developerMetadata(metadataKey,metadataValue),sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)))'});
 var marker=(meta.developerMetadata||[]).find(function(x){if(x.metadataKey!=='warehouse-reset')return false;try{var v=JSON.parse(x.metadataValue);return v.id===args.id&&v.token===sha_(token);}catch(e){return false;}});
 if(marker){var prior=JSON.parse(marker.metadataValue);return{reset:true,duplicate:true,backups:prior.backups,time:prior.time};}
 var member=lookup_(tables.members,function(x){return x.token===sha_(token);});
 if(!member)reject_('当前管理员会话无效，未清除任何数据',401);
 if(member.value.role!=='admin')reject_('仅管理员可以清除全部数据',403);
 var prefix='清除备份_'+Date.now()+'_'+args.id.slice(0,6)+'_',backups=[],requests=[];
 Object.keys(TABLES).forEach(function(k){var name=prefix+TABLES[k].sheet;backups.push(name);requests.push({duplicateSheet:{sourceSheetId:tables[k].id,newSheetName:name}});});
 Object.keys(TABLES).forEach(function(k){var sheet=meta.sheets.find(function(s){return s.properties.sheetId===tables[k].id;});var grid=sheet.properties.gridProperties;if(grid.rowCount>1)requests.push({updateCells:{range:{sheetId:tables[k].id,startRowIndex:1,endRowIndex:grid.rowCount,startColumnIndex:0,endColumnIndex:grid.columnCount||TABLES[k].keys.length},rows:[],fields:'userEnteredValue'}});});
 var record={id:args.id,token:sha_(token),time:new Date().toISOString(),backups:backups};requests.push({createDeveloperMetadata:{developerMetadata:{metadataKey:'warehouse-reset',metadataValue:JSON.stringify(record),visibility:'DOCUMENT',location:{spreadsheet:true}}}});
 // Backup all four tables, clear them, and save the retry marker in one atomic batch.
 Sheets.Spreadsheets.batchUpdate({requests:requests},id);return{reset:true,backups:backups,time:record.time};
}
function recoverTask_(tables,args,token){
 var found=lookup_(tables.members,function(x){return x.token===sha_(token);});if(!found)reject_('会话已失效，请先导出本机记录，再重新加入任务',401);
 var m=found.value;if(m.role!=='admin')reject_('请由该任务的管理员恢复任务',403);if(args.taskId!==m.task)reject_('本机任务关联不一致，未修改任何数据',409);
 if(lookup_(tables.tasks,function(x){return x.id===m.task;}))return{changes:[],data:publicSnapshot_(tables,m)};
 if(typeof args.title!=='string'||!args.title.trim()||args.title.length>80||!Array.isArray(args.base)||args.base.length>2000)reject_('本机任务快照无效');
 if(!/^(?:\d{8}|[a-fA-F0-9]{16})$/.test(String(args.code||'')))reject_('本机任务码无效');
 if(lookup_(tables.tasks,function(t){return t.code===args.code;}))reject_('本机任务码与其他任务冲突，请联系管理员',409);
 var changes=[];function add(k,value){var row=tables[k].rows.reduce(function(n,r){return Math.max(n,r.row+1);},1);tables[k].rows.push({row:row,value:value});changes.push({table:k,row:row,value:value});}
 var revision=Number.isSafeInteger(args.revision)&&args.revision>=0?args.revision:0;
 args.base.forEach(function(b){if(!/^\d{8}$/.test(b.barcode||''))reject_('本机订单号无效');['actual','estimate'].forEach(function(k){if(!Number.isSafeInteger(b[k])||b[k]<0||b[k]>999999999)reject_('本机数量快照无效');});
 if(lookup_(tables.orders,function(o){return o.task===m.task&&o.barcode===b.barcode;}))return;
 var o={task:m.task,barcode:b.barcode,actual:b.actual,estimate:b.estimate,filled:b.hasFilledEstimate?1:0,abnormal:b.abnormal?1:0,scans:Number(b.scanCount)||b.actual,version:Number(b.version)||0,estimateVersion:Number(b.estimateVersion)||0,actualVersion:Number(b.actualVersion)||0,updated:Number(b.lastScanTime)||revision};revision=Math.max(revision,o.updated);add('orders',o);
 if(b.done)add('operations',{task:m.task,id:'recover-done-'+Utilities.getUuid(),token:m.token,payload:'恢复完成标记',actor:m.name,kind:'done',barcode:b.barcode,beforeValue:'',afterValue:JSON.stringify(Object.assign({},o,{done:1})),time:new Date().toISOString()});
 });
 add('tasks',{id:m.task,code:String(args.code).toUpperCase(),title:args.title.trim(),status:args.archived?'archived':'active',revision:revision});
 add('operations',{task:m.task,id:'recover-'+Utilities.getUuid(),token:m.token,payload:'管理员从本机最后云端快照恢复缺失任务；未覆盖现存订单',actor:m.name,kind:'recover',barcode:'',beforeValue:'',afterValue:JSON.stringify({title:args.title,orders:args.base.length}),time:new Date().toISOString()});
 return{changes:changes,data:publicSnapshot_(tables,m)};
}

function browserRequest(request){
  var lock;
  try{
    if(!request||JSON.stringify(request).length>(request.action==='recover'?1000000:120000))reject_('请求格式错误');
    var action=request.action;
    if(action==='ping')return{ok:true,data:{online:true,backend:'Google Sheets',version:2}};
    if(!['create','join','state','op','history','sync','recover','reset','resetStatus'].includes(action))reject_('浏览器不允许调用此接口',403);
    if(!/^[a-f0-9]{48}$/.test(request.token||''))reject_('会话无效，请重新加入任务',401);
    lock=LockService.getScriptLock();if(!lock.tryLock(20000))reject_('云端正在处理其他操作，请稍后用原编号重试',503);
    var props=PropertiesService.getScriptProperties(),id=props.getProperty('SPREADSHEET_ID'),ids=JSON.parse(props.getProperty('SHEET_IDS')||'null');
    if(!id||!ids)reject_('表格尚未初始化',503);
    var args=Object.assign({},request.args||{});
    if(action==='create'){
      args.taskId=sha_(Utilities.getUuid()+Utilities.getUuid()).slice(0,48);
      args.code='';
    }
    var tables=readTables_(id,ids),result;
    if(action==='reset')return{ok:true,data:resetAll_(id,tables,args,request.token)};
    if(action==='resetStatus'){var admin=lookup_(tables.members,function(m){return m.token===sha_(request.token);});if(!admin||admin.value.role!=='admin')reject_('仅管理员可以查看清除设置',403);return{ok:true,data:{configured:!!props.getProperty('RESET_PASSWORD_HASH')}};}
    if(action==='recover'){var recovered=recoverTask_(tables,args,request.token);commit_(id,tables,recovered.changes);return{ok:true,data:recovered.data};}
    if(action==='create'){
      var reserved=Object.values(taskCodes_(tables));
      for(var attempt=0;attempt<100;attempt++){var candidate=String(parseInt(sha_(Utilities.getUuid()).slice(0,12),16)%100000000).padStart(8,'0');if(reserved.indexOf(candidate)<0){args.code=candidate;break;}}
      if(!args.code)reject_('任务码繁忙，请重试',503);
    }
    if(action==='sync'){
      if(!Array.isArray(args.operations)||args.operations.length>80)reject_('每批最多80项操作');
      // Authenticate even an empty batch. Failed plans never mutate the committed prefix.
      plan_(tables,'state',{},request.token);
      var accepted=[],changes=[],conflict=null;
      for(var index=0;index<args.operations.length;index++){
        var operation=args.operations[index],candidate=JSON.parse(JSON.stringify(tables));
        try{
          var planned=plan_(candidate,'op',operation,request.token);
          tables=candidate;changes=changes.concat(planned.changes);accepted.push(operation.id);
        }catch(err){conflict={id:operation.id,status:err.status||503,error:err.status?err.message:'此项结果待确认，请保留记录重试'};break;}
      }
      // Snapshot/history are read only on the user's manual refresh.
      commit_(id,tables,changes);
      return {ok:true,data:{accepted:accepted,conflict:conflict,snapshot:plan_(tables,'state',{},request.token).data}};
    }
    result=plan_(tables,action,args,request.token);
    commit_(id,tables,result.changes);
    return{ok:true,data:result.data};
  }catch(error){return{ok:false,status:error.status||503,error:error.status?error.message:'Google Sheets 暂时不可用，结果待确认，请使用原编号重试'};}
  finally{if(lock&&lock.hasLock())lock.releaseLock();}
}
function doGet(e){
  var channel=String(e&&e.parameter&&e.parameter.channel||'');
  if(!/^[a-f0-9]{32}$/.test(channel))return json_({online:true,service:'仓库箱数核验',transport:'Google Sheets',version:2});
  var origin='https://rchen0012.github.io';
  var html='<!DOCTYPE html><html><head><meta charset="utf-8"><title>Google Sheets connection</title></head><body><script>'+
    'const channel='+JSON.stringify(channel)+',origin='+JSON.stringify(origin)+';'+
    'function send(value){window.top.postMessage(Object.assign({channel:channel},value),origin);}'+
    'const ready=setInterval(()=>send({type:"warehouse-ready",version:2}),1000);send({type:"warehouse-ready",version:2});'+
    'window.addEventListener("message",function(event){const d=event.data;if(event.origin!==origin||event.source!==window.top||!d||d.channel!==channel||d.type!=="warehouse-request")return;clearInterval(ready);'+
    'google.script.run.withSuccessHandler(function(result){send({type:"warehouse-response",id:d.id,result:result});})'+
    '.withFailureHandler(function(){send({type:"warehouse-response",id:d.id,result:{ok:false,status:503,error:"Google Sheets 请求失败，结果待确认"}});}).browserRequest(d.request);});'+
    '</script></body></html>';
  return HtmlService.createHtmlOutput(html).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}
