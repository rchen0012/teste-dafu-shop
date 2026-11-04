/* Camera and pull gestures have no network side effects. */
var MobileScanGate=class {
 constructor(){this.reset();}
 reset(){this.code='';this.armed=true;this.lastSeen=0;this.misses=0;}
 hit(code,time){const changed=code!==this.code;this.lastSeen=time;this.misses=0;if(!this.armed&&!changed)return false;this.code=code;this.armed=false;return true;}
 miss(time){if(this.armed)return;this.misses++;if(this.misses>=3&&time-this.lastSeen>=550)this.armed=true;}
};
var PullSyncGesture=class {
 start(x,y){this.origin={x,y};this.distance=0;}
 move(x,y){if(!this.origin)return 0;const dy=y-this.origin.y;if(Math.abs(x-this.origin.x)>60||dy<0){this.cancel();return 0;}this.distance=dy;return dy;}
 finish(){const fire=!!this.origin&&this.distance>=85;this.cancel();return fire;}
 cancel(){this.origin=null;this.distance=0;}
};
if(typeof module!=='undefined')module.exports={MobileScanGate,PullSyncGesture};

var CameraScanConfig={
 box(width,height){return{width:Math.floor(Math.min(width*.92,720)),height:Math.floor(Math.min(height*.7,Math.max(140,width*.58)))};},
 options(enhanced=true){const options={fps:20,qrbox:(w,h)=>this.box(w,h),disableFlip:false};if(enhanced)options.videoConstraints={facingMode:{ideal:'environment'},width:{ideal:1920},height:{ideal:1080}};return options;},
 async focus(camera){try{const caps=camera.getRunningTrackCapabilities?.();if(caps?.focusMode?.includes('continuous'))await camera.applyVideoConstraints({advanced:[{focusMode:'continuous'}]});}catch(e){/* Optional focus constraints must not stop recognition. */}}
};
if(typeof module!=='undefined')module.exports.CameraScanConfig=CameraScanConfig;
