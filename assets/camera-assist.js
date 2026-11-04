/* Optional camera enhancements. No network or storage access. */
var CameraAssist={async mount(camera,root,onCode){
 const old=root.querySelector('.camera-tools');if(old)old.remove();
 const video=root.querySelector('video');if(!video)return;
 let caps={};try{caps=camera.getRunningTrackCapabilities?.()||{}}catch(e){}
 const tools=document.createElement('div');tools.className='camera-tools smallbuttons';
 const status=document.createElement('p');status.className='hint';status.textContent='连续识别中：将完整二维码放入画面，保持约15–30厘米距离。';
 const button=(label,action)=>{const b=document.createElement('button');b.type='button';b.textContent=label;b.onclick=async()=>{b.disabled=true;try{await action(b)}catch(e){status.textContent='此手机不支持该设置，可调整距离或光线后继续扫描。'}finally{b.disabled=false}};tools.appendChild(b);return b};
 button('◎ 重新对焦',async()=>{if(caps.focusMode?.includes('single-shot'))await camera.applyVideoConstraints({advanced:[{focusMode:'single-shot'}]});await CameraScanConfig.focus(camera);status.textContent='已重新请求自动对焦，请稍稳住手机。'});
 if(caps.torch){let torch=false;button('🔦 开启补光',async b=>{await camera.applyVideoConstraints({advanced:[{torch:!torch}]});torch=!torch;b.textContent=torch?'🔦 关闭补光':'🔦 开启补光'})}
 if(caps.zoom&&Number.isFinite(caps.zoom.min)&&Number.isFinite(caps.zoom.max)&&caps.zoom.max>caps.zoom.min){const label=document.createElement('label');label.textContent='放大二维码 ';const range=document.createElement('input');range.type='range';range.min=String(caps.zoom.min);range.max=String(Math.min(caps.zoom.max,Math.max(caps.zoom.min,3)));range.step=String(caps.zoom.step||.1);range.value=String(Math.min(Number(range.max),Math.max(caps.zoom.min,camera.getRunningTrackSettings?.().zoom||caps.zoom.min)));range.setAttribute('aria-label','摄像头放大倍数');range.onchange=async()=>{try{await camera.applyVideoConstraints({advanced:[{zoom:Number(range.value)}]});await CameraScanConfig.focus(camera)}catch(e){status.textContent='此手机无法调整放大倍数，请改变扫码距离。'}};label.appendChild(range);tools.appendChild(label)}
 root.appendChild(tools);root.appendChild(status);
 // Read full-resolution video directly on supported browsers; the library remains the fallback.
 if(typeof BarcodeDetector==='undefined')return;
 try{const supported=await BarcodeDetector.getSupportedFormats();const formats=['qr_code'].filter(x=>supported.includes(x));if(!formats.length)return;const detector=new BarcodeDetector({formats});const tick=async()=>{if(!camera.isScanning||!video.isConnected)return;try{if(video.readyState>=2&&!video.paused){const codes=await detector.detect(video);for(const code of codes)if(/^\d{8}$/.test(String(code.rawValue||'').trim())){onCode(code.rawValue);break}}}catch(e){/* Keep the library decoder active when native detection fails. */}if(camera.isScanning&&video.isConnected)setTimeout(tick,160)};tick();status.textContent='高清快速识别已启用；保持完整二维码在画面内。';}catch(e){/* Native detector is optional. */}
}};
if(typeof module!=='undefined')module.exports=CameraAssist;
