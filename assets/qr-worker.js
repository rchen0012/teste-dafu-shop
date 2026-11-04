/* jsQR 1.4.0 (Apache-2.0), served locally; frames never leave this worker. */
importScripts('./jsqr.js?v=13','./qr-decode.js?v=13');
self.onmessage=function(event){const {id,width,height,buffer,invert}=event.data;try{const text=QrDecode(new Uint8ClampedArray(buffer),width,height,invert);self.postMessage({id,text})}catch(e){self.postMessage({id,text:'',error:true})}};
