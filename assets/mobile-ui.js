/* Camera and pull gestures have no network side effects. */
var MobileScanGate=class {
 constructor(){this.reset();}
 reset(){this.code='';this.armed=true;this.lastSeen=0;this.misses=0;}
 hit(code,time){const changed=code!==this.code;this.lastSeen=time;this.misses=0;if(!this.armed&&!changed)return false;this.code=code;this.armed=false;return true;}
 miss(time){if(this.armed)return;this.misses++;if(this.misses>=6&&time-this.lastSeen>=900)this.armed=true;}
};
var PullSyncGesture=class {
 start(x,y){this.origin={x,y};this.distance=0;}
 move(x,y){if(!this.origin)return 0;const dy=y-this.origin.y;if(Math.abs(x-this.origin.x)>60||dy<0){this.cancel();return 0;}this.distance=dy;return dy;}
 finish(){const fire=!!this.origin&&this.distance>=85;this.cancel();return fire;}
 cancel(){this.origin=null;this.distance=0;}
};
if(typeof module!=='undefined')module.exports={MobileScanGate,PullSyncGesture};
