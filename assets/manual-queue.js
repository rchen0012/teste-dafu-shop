/* Durable local outbox. Upload is only initiated by the user's refresh gesture. */
var ManualQueue = class {
  static replay(orders, operations) {
    const result=structuredClone(orders);
    for(const b of operations){
      let o=result.find(o=>o.barcode===b.barcode);
      if(!o&&b.kind==='scan'){o={barcode:b.barcode,actual:0,estimate:0,hasFilledEstimate:false,version:0,actualVersion:0,estimateVersion:0};result.unshift(o);}
      if(!o)continue;
      if(b.kind==='scan'||b.kind==='adjust')o.actual+=b.kind==='scan'?1:b.value;
      if(b.kind==='estimate'){o.estimate=b.value;o.hasFilledEstimate=true;}
      if(b.kind==='done')o.done=!!b.value;
      if(b.kind==='abnormal')o.abnormal=b.value===undefined?true:!!b.value;
    }
    return result;
  }
  static enqueue(cloud, entries) {
    const next=structuredClone(cloud);
    for(const entry of entries)next.outbox.push({id:crypto.randomUUID(),...entry,clientTime:new Date().toISOString()});
    return next;
  }
};
if(typeof module!=='undefined')module.exports=ManualQueue;
