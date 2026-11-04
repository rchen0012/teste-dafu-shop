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
 box(width,height){return{width:Math.max(1,Math.floor(width*.96)),height:Math.max(1,Math.floor(height*.9))};},
 options(enhanced=true){const options={fps:20,qrbox:(w,h)=>this.box(w,h),disableFlip:true};if(enhanced)options.videoConstraints={facingMode:{ideal:'environment'},width:{ideal:1920},height:{ideal:1080},frameRate:{ideal:30,max:30}};return options;},
 async focus(camera){let caps;try{caps=camera.getRunningTrackCapabilities?.()||{}}catch(e){return}for(const [name,value] of [['focusMode','continuous'],['exposureMode','continuous'],['whiteBalanceMode','continuous']]){try{if(caps[name]?.includes(value))await camera.applyVideoConstraints({advanced:[{[name]:value}]});}catch(e){/* Each optional enhancement falls back independently. */}}}

};
if(typeof module!=='undefined')module.exports.CameraScanConfig=CameraScanConfig;
