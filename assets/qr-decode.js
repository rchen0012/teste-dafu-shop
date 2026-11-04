/* Local QR decoding with conditional contrast recovery. */
(function(scope){const reader=typeof module!=='undefined'&&module.exports?require('./jsqr.js'):scope.jsQR;
 function decode(data,width,height,invert=false){const options={inversionAttempts:invert?'attemptBoth':'dontInvert'};let result=reader(data,width,height,options);if(result)return result.data;
 const histogram=new Uint32Array(256);let count=0;for(let i=0;i<data.length;i+=16){histogram[Math.round((data[i]*77+data[i+1]*150+data[i+2]*29)/256)]++;count++}let low=0,high=255,sum=0;for(let i=0;i<256;i++){sum+=histogram[i];if(sum>=count*.02){low=i;break}}sum=0;for(let i=255;i>=0;i--){sum+=histogram[i];if(sum>=count*.02){high=i;break}}if(high-low<20||high-low>190)return'';
 const corrected=new Uint8ClampedArray(data.length);for(let i=0;i<data.length;i+=4){const gray=(data[i]*77+data[i+1]*150+data[i+2]*29)/256;const value=(gray-low)*255/(high-low);corrected[i]=corrected[i+1]=corrected[i+2]=value;corrected[i+3]=255}result=reader(corrected,width,height,options);return result?.data||'';
 }scope.QrDecode=decode;if(typeof module!=='undefined')module.exports=decode;
})(typeof self!=='undefined'?self:globalThis);
