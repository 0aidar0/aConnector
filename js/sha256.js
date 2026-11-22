/* Инкрементальный SHA-256 (без зависимостей). */
(function (global) {
  'use strict';

  var K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ]);

  function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }

  function SHA256() {
    this.h = new Uint32Array([
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
    ]);
    this.block = new Uint8Array(64);
    this.blockLen = 0;
    this.total = 0; // байты (Number, до 2^53)
    this.w = new Uint32Array(64);
    this.finished = false;
  }

  SHA256.prototype._compress = function (p) {
    var w = this.w, h = this.h, i;
    for (i = 0; i < 16; i++) {
      w[i] = (p[i * 4] << 24) | (p[i * 4 + 1] << 16) | (p[i * 4 + 2] << 8) | p[i * 4 + 3];
    }
    for (i = 16; i < 64; i++) {
      var x = w[i - 15], y = w[i - 2];
      var s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
      var s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (i = 0; i < 64; i++) {
      var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      var ch = (e & f) ^ (~e & g);
      var t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
      var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      var maj = (a & b) ^ (a & c) ^ (b & c);
      var t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  };

  SHA256.prototype.update = function (data) {
    if (this.finished) throw new Error('SHA256: already finished');
    if (!(data instanceof Uint8Array)) data = new Uint8Array(data);
    var off = 0, len = data.length;
    this.total += len;

    if (this.blockLen > 0) {
      var need = 64 - this.blockLen;
      var take = Math.min(need, len);
      this.block.set(data.subarray(0, take), this.blockLen);
      this.blockLen += take;
      off += take;
      if (this.blockLen === 64) {
        this._compress(this.block);
        this.blockLen = 0;
      }
    }

    while (off + 64 <= len) {
      this._compress(data.subarray(off, off + 64));
      off += 64;
    }

    if (off < len) {
      this.block.set(data.subarray(off), 0);
      this.blockLen = len - off;
    }
    return this;
  };

  SHA256.prototype.digest = function () {
    if (this.finished) throw new Error('SHA256: already finished');
    var total = this.total;
    var padLen = this.blockLen < 56 ? 56 - this.blockLen : 120 - this.blockLen;
    var pad = new Uint8Array(padLen + 8);
    pad[0] = 0x80;
    var bitsHi = Math.floor(total / 0x20000000) >>> 0; // total*8 / 2^32
    var bitsLo = (total * 8) >>> 0;
    var dv = new DataView(pad.buffer);
    dv.setUint32(padLen, bitsHi);
    dv.setUint32(padLen + 4, bitsLo);
    this.update(pad);
    this.finished = true;

    var out = new Uint8Array(32);
    var view = new DataView(out.buffer);
    for (var i = 0; i < 8; i++) view.setUint32(i * 4, this.h[i]);
    return out;
  };

  function hex(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
    return s;
  }

  // Потоковый хэш Blob/File: не держит весь файл в памяти.
  async function sha256Blob(blob, onProgress) {
    var hasher = new SHA256();
    var CHUNK = 4 * 1024 * 1024;
    var offset = 0;
    while (offset < blob.size) {
      var end = Math.min(offset + CHUNK, blob.size);
      var buf = await blob.slice(offset, end).arrayBuffer();
      hasher.update(new Uint8Array(buf));
      offset = end;
      if (onProgress) onProgress(offset, blob.size);
    }
    return hex(hasher.digest());
  }

  async function sha256Text(text) {
    var hasher = new SHA256();
    hasher.update(new TextEncoder().encode(text));
    return hex(hasher.digest());
  }

  global.SHA256 = SHA256;
  global.sha256Blob = sha256Blob;
  global.sha256Text = sha256Text;
  global.bytesToHex = hex;
})(window);
