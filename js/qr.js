/* QR: отрисовка (qrcode-generator) и распознавание (jsQR). */
(function (global) {
  'use strict';

  function draw(canvas, text) {
    if (typeof global.qrcode !== 'function') throw new Error('QR-библиотека не загружена');
    var qr = global.qrcode(0, 'L');
    qr.addData(text, 'Byte');
    qr.make();

    var count = qr.getModuleCount();
    var quiet = 4;
    var scale = Math.max(2, Math.floor(760 / (count + quiet * 2)));
    var size = (count + quiet * 2) * scale;

    canvas.width = size;
    canvas.height = size;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#08101c';
    for (var r = 0; r < count; r++) {
      for (var c = 0; c < count; c++) {
        if (qr.isDark(r, c)) {
          ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
        }
      }
    }
    return { count: count, size: size };
  }

  function decode(imageData) {
    if (typeof global.jsQR !== 'function') return null;
    return global.jsQR(imageData.data, imageData.width, imageData.height, {
      inversionAttempts: 'attemptBoth'
    });
  }

  global.MeshQR = { draw: draw, decode: decode };
})(window);
