/* Owned local state only: unrelated apps on the same GitHub origin are untouched. */
var LocalTaskState={
 pendingAfterRefresh(cloud,snapshot,logs){
  return (cloud.outbox||[]).filter(op=>{
   if(op.kind==='archive'&&snapshot.task.status==='archived')return false;
   const payload=JSON.stringify([op.kind,op.barcode??null,op.value??null,op.expectedVersion??null,op.reason??null].concat(op.clientTime?[op.clientTime]:[]));
   return !logs.some(log=>log.id===op.id&&log.kind===op.kind&&log.payload===payload);
  });
 },
 trimSavedTasks(tasks){
  return (tasks||[]).map(t=>({...t,logs:[],cloud:{...t.cloud}}));
 }
};
if(typeof module!=='undefined')module.exports=LocalTaskState;
