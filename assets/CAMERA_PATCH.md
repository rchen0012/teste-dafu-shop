# Camera backing resolution

The bundled html5-qrcode live draw destination uses the canvas backing width/height instead of CSS scan-region dimensions. CameraAssist raises only the live camera canvas to at most 640 pixels, preserving source detail in the compact QR region. File decoding remains unchanged. Reapply this one draw-destination change if upgrading the vendor library.
