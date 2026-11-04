/* Quantity mismatch is derived; manual marks remain a separate shared flag. */
var OrderCheck={
 get(o){
  const actual=Number(o.actual)||0,hasEstimate=Number.isInteger(o.estimate)&&o.estimate>0;
  const difference=hasEstimate?actual-o.estimate:null,shortage=hasEstimate?Math.max(0,-difference):0,excess=hasEstimate?Math.max(0,difference):0;
  const manual=!!o.manualAbnormal;
  const abnormal=manual||(hasEstimate&&difference!==0);
  const label=shortage?'少扫 '+shortage+' 箱':excess?'超出 '+excess+' 箱':manual?'人工标记异常':hasEstimate?'数量一致':'待填预估';
  return{hasEstimate,difference,shortage,excess,manual,abnormal,label};
 },
 normalize(orders,base=[],outbox=[]){
  for(const o of orders){
   if(typeof o.manualAbnormal!=='boolean'){
    const queued=[...outbox].reverse().find(b=>b.barcode===o.id&&b.kind==='abnormal'),shared=base.find(b=>b.barcode===o.id);
    o.manualAbnormal=queued?!!queued.value:shared?!!shared.abnormal:!!o.exception&&!(Number.isInteger(o.estimate)&&o.actual>o.estimate);
   }
   o.exception=this.get(o).abnormal;
  }
  return orders;
 }
};
if(typeof module!=='undefined')module.exports=OrderCheck;
