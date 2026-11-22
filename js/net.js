/* WebRTC: упаковка сигналов, P2P-канал, передача файлов. */
(function (global) {
  'use strict';

  var CHUNK_SIZE = 64 * 1024;
  var SIGNAL_TTL = 2 * 60 * 1000;
  var BUF_HIGH = 4 * 1024 * 1024;
  var BUF_LOW = 512 * 1024;
  var FLUSH_AT = 2 * 1024 * 1024;

  /* ---------- base64url ---------- */

  function b64uEncode(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function b64uDecode(str) {
    var s = String(str).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    var bin = atob(s);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function randomId() {
    var b = new Uint8Array(16);
    crypto.getRandomValues(b);
    var s = '';
    for (var i = 0; i < b.length; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16);
    return s;
  }

  // Приводим метаданные от собеседника к безопасному виду.
  function cleanMeta(f) {
    if (!f || !f.id) return null;
    return {
      id: String(f.id).slice(0, 64),
      name: String(f.name || 'file').slice(0, 512),
      size: Math.max(0, Number(f.size) || 0),
      type: String(f.type || '').slice(0, 128),
      hash: String(f.hash || '').slice(0, 128),
      mtime: Number(f.mtime) || 0
    };
  }

  /* ---------- упаковка сигнального кода ---------- */

  async function packSignal(obj) {
    var raw = new TextEncoder().encode(JSON.stringify(obj));
    var bytes = raw;
    var flag = 'r';
    if (typeof CompressionStream !== 'undefined') {
      try {
        var stream = new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate-raw'));
        var packed = new Uint8Array(await new Response(stream).arrayBuffer());
        if (packed.length < raw.length) {
          bytes = packed;
          flag = 'z';
        }
      } catch (e) { /* без сжатия */ }
    }
    return 'MD1' + flag + b64uEncode(bytes);
  }

  async function unpackSignal(text) {
    var clean = String(text || '').trim().replace(/\s+/g, '');
    if (clean.indexOf('MD1') !== 0) throw new Error('Это не код MeshDrop');
    var flag = clean.charAt(3);
    var bytes = b64uDecode(clean.slice(4));
    var raw;
    if (flag === 'z') {
      if (typeof DecompressionStream === 'undefined') {
        throw new Error('Этот браузер не поддерживает сжатые коды');
      }
      var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      raw = new Uint8Array(await new Response(stream).arrayBuffer());
    } else if (flag === 'r') {
      raw = bytes;
    } else {
      throw new Error('Неизвестный формат кода');
    }
    var data = JSON.parse(new TextDecoder().decode(raw));
    if (!data || !data.sdp || !data.t) throw new Error('Повреждённый код');
    return data;
  }

  async function pinFrom(seed) {
    var hex = await sha256Text('meshdrop-pin:' + seed);
    var n = parseInt(hex.slice(0, 8), 16) % 1000000;
    return String(n).padStart(6, '0');
  }

  /* ---------- WebRTC ---------- */

  function buildIceServers(settings) {
    var servers = [];
    var stun = (settings && settings.stun) || [];
    stun.forEach(function (url) {
      if (url && String(url).trim()) servers.push({ urls: String(url).trim() });
    });
    if (settings && settings.turnUrl && String(settings.turnUrl).trim()) {
      var urls = String(settings.turnUrl).split(/[\s,]+/).filter(Boolean);
      servers.push({
        urls: urls,
        username: settings.turnUser || '',
        credential: settings.turnPass || ''
      });
    }
    if (!servers.length) servers.push({ urls: 'stun:stun.l.google.com:19302' });
    return servers;
  }

  function createPC(settings) {
    return new RTCPeerConnection({
      iceServers: buildIceServers(settings),
      iceCandidatePoolSize: 0
    });
  }

  function waitIce(pc, timeout) {
    timeout = timeout || 4500;
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise(function (resolve) {
      var timer = null;
      function finish() {
        if (timer) clearTimeout(timer);
        pc.removeEventListener('icegatheringstatechange', check);
        resolve();
      }
      function check() {
        if (pc.iceGatheringState === 'complete') finish();
      }
      pc.addEventListener('icegatheringstatechange', check);
      timer = setTimeout(finish, timeout);
    });
  }

  /* ---------- канал и протокол ---------- */

  function PeerLink(dc, opts) {
    this.dc = dc;
    this.name = opts.name || 'Устройство';
    this.getManifest = opts.getManifest || function () { return []; };
    this.getFile = opts.getFile || async function () { return null; };
    this.onEvent = opts.onEvent || function () {};
    this.remote = { name: null, files: new Map() };
    this.incoming = new Map();
    this.queue = [];
    this.sending = new Set();
    this.requested = new Set();
    this.closed = false;

    var self = this;
    dc.binaryType = 'arraybuffer';
    try { dc.bufferedAmountLowThreshold = BUF_LOW; } catch (e) {}
    dc.onmessage = function (e) { self._onData(e.data); };
    dc.onclose = function () { self.closed = true; self.onEvent('close'); };
    dc.onerror = function () { self.onEvent('error', new Error('Ошибка канала данных')); };

    this.sendHello();
  }

  PeerLink.prototype.send = function (obj) {
    if (this.dc.readyState !== 'open') return false;
    try {
      this.dc.send(JSON.stringify(obj));
      return true;
    } catch (e) {
      return false;
    }
  };

  PeerLink.prototype.sendHello = function () {
    this.send({ t: 'hello', v: 1, name: this.name, files: this.getManifest() });
  };

  PeerLink.prototype.request = function (id) {
    if (!id || this.requested.has(id)) return;
    this.requested.add(id);
    this.send({ t: 'want', id: id });
  };

  PeerLink.prototype.close = function () {
    this.closed = true;
    this.incoming.forEach(function (entry, id) {
      Store.deleteChunks(id + ':').catch(function () {});
    });
    this.incoming.clear();
    try { this.dc.close(); } catch (e) {}
  };

  PeerLink.prototype._pump = function () {
    var self = this;
    while (this.queue.length && this.sending.size < 2) {
      var id = this.queue.shift();
      if (!id || this.sending.has(id)) continue;
      this.sending.add(id);
      (function (fileId) {
        self._sendFile(fileId)
          .catch(function (err) { self.onEvent('error', err); })
          .then(function () {
            self.sending.delete(fileId);
            self._pump();
          });
      })(id);
    }
  };

  PeerLink.prototype._sendFile = async function (id) {
    var found = null;
    try { found = await this.getFile(id); } catch (e) { found = null; }
    if (!found) {
      this.send({ t: 'nofile', id: id });
      this.onEvent('nofile', { id: id });
      return;
    }
    var meta = found.meta;
    var blob = found.blob;
    var total = Math.ceil(blob.size / CHUNK_SIZE);

    this.send({ t: 'file-start', file: meta, chunks: total });
    this.onEvent('progress', { id: id, dir: 'out', name: meta.name, loaded: 0, total: blob.size, status: 'active' });

    var sent = 0;
    try {
      for (var i = 0; i < total; i++) {
        var end = Math.min((i + 1) * CHUNK_SIZE, blob.size);
        var buf = await blob.slice(i * CHUNK_SIZE, end).arrayBuffer();
        await this._waitBuffer();
        this.dc.send(this._packet(meta.id, i, buf));
        sent += buf.byteLength;
        this.onEvent('progress', { id: id, dir: 'out', name: meta.name, loaded: sent, total: blob.size, status: 'active' });
      }
    } catch (err) {
      this.onEvent('progress', { id: id, dir: 'out', name: meta.name, loaded: sent, total: blob.size, status: 'error' });
      throw err;
    }
    this.send({ t: 'file-end', id: meta.id });
    this.onEvent('progress', { id: id, dir: 'out', name: meta.name, loaded: blob.size, total: blob.size, status: 'sent' });
  };

  PeerLink.prototype._packet = function (id, index, buffer) {
    var header = new TextEncoder().encode(JSON.stringify({ id: id, i: index }));
    var out = new Uint8Array(3 + header.length + buffer.byteLength);
    out[0] = 1;
    new DataView(out.buffer).setUint16(1, header.length);
    out.set(header, 3);
    out.set(new Uint8Array(buffer), 3 + header.length);
    return out;
  };

  PeerLink.prototype._waitBuffer = function () {
    var self = this;
    if (this.dc.bufferedAmount < BUF_HIGH) return Promise.resolve();
    return new Promise(function (resolve) {
      var timer = setTimeout(finish, 15000);
      function finish() {
        clearTimeout(timer);
        self.dc.removeEventListener('bufferedamountlow', finish);
        resolve();
      }
      self.dc.addEventListener('bufferedamountlow', finish);
    });
  };

  PeerLink.prototype._onData = function (data) {
    if (typeof data === 'string') {
      var msg;
      try { msg = JSON.parse(data); } catch (e) { return; }
      this._onControl(msg);
      return;
    }
    if (data instanceof ArrayBuffer) this._onChunk(data);
    else if (data && data.buffer) this._onChunk(data.buffer);
  };

  PeerLink.prototype._onControl = function (msg) {
    if (!msg || !msg.t) return;
    switch (msg.t) {
      case 'hello': {
        this.remote.name = msg.name || 'Собеседник';
        this.remote.files.clear();
        (msg.files || []).forEach(function (f) {
          var clean = cleanMeta(f);
          if (clean) this.remote.files.set(clean.id, clean);
        }, this);
        this.onEvent('hello', { name: this.remote.name, files: Array.from(this.remote.files.values()) });
        break;
      }
      case 'manifest': {
        this.remote.files.clear();
        (msg.files || []).forEach(function (f) {
          var clean = cleanMeta(f);
          if (clean) this.remote.files.set(clean.id, clean);
        }, this);
        this.onEvent('manifest', { files: Array.from(this.remote.files.values()) });
        break;
      }
      case 'add': {
        var cleanAdd = cleanMeta(msg.file);
        if (!cleanAdd) return;
        this.remote.files.set(cleanAdd.id, cleanAdd);
        this.onEvent('add', { file: cleanAdd });
        break;
      }
      case 'del': {
        if (!msg.id) return;
        this.remote.files.delete(msg.id);
        this.requested.delete(msg.id);
        this.onEvent('del', { id: msg.id });
        break;
      }
      case 'want': {
        if (!msg.id) return;
        this.queue.push(msg.id);
        this._pump();
        break;
      }
      case 'nofile': {
        this.requested.delete(msg.id);
        this.onEvent('nofile', { id: msg.id });
        break;
      }
      case 'file-start': {
        if (!msg.file || !msg.file.id) return;
        this._beginIncoming(msg.file, msg.chunks || 0);
        break;
      }
      case 'file-end': {
        if (msg.id) this._finishIncoming(msg.id);
        break;
      }
      case 'file-done': {
        this.onEvent('delivered', { id: msg.id, ok: !!msg.ok, error: msg.error });
        break;
      }
      case 'ping': {
        this.send({ t: 'pong' });
        break;
      }
      default: break;
    }
  };

  PeerLink.prototype._beginIncoming = function (file, chunks) {
    var clean = cleanMeta(file);
    if (!clean) return;
    if (this.incoming.has(clean.id)) return;
    var entry = {
      meta: clean,
      totalChunks: chunks,
      received: 0,
      bytes: 0,
      parts: [],
      bufferedBytes: 0,
      flushed: false,
      chunkIndex: 0,
      chain: Promise.resolve()
    };
    this.incoming.set(clean.id, entry);
    this.onEvent('progress', { id: clean.id, dir: 'in', name: clean.name, loaded: 0, total: clean.size, status: 'active' });
  };

  PeerLink.prototype._onChunk = function (buffer) {
    var bytes = new Uint8Array(buffer);
    if (bytes.length < 4 || bytes[0] !== 1) return;
    var headerLen = (bytes[1] << 8) | bytes[2];
    var header;
    try {
      header = JSON.parse(new TextDecoder().decode(bytes.subarray(3, 3 + headerLen)));
    } catch (e) { return; }
    var entry = this.incoming.get(header.id);
    if (!entry) return;

    var payload = bytes.slice(3 + headerLen);
    entry.parts.push(payload);
    entry.bufferedBytes += payload.length;
    entry.bytes += payload.length;
    entry.received++;

    this.onEvent('progress', {
      id: entry.meta.id,
      dir: 'in',
      name: entry.meta.name,
      loaded: entry.bytes,
      total: entry.meta.size,
      status: 'active'
    });

    if (entry.bufferedBytes >= FLUSH_AT) this._flush(entry);
  };

  PeerLink.prototype._flush = function (entry) {
    if (!entry.parts.length) return;
    var parts = entry.parts;
    entry.parts = [];
    entry.bufferedBytes = 0;
    entry.flushed = true;
    var self = this;
    entry.chain = entry.chain.then(async function () {
      for (var i = 0; i < parts.length; i++) {
        var key = entry.meta.id + ':' + String(entry.chunkIndex++).padStart(8, '0');
        await Store.putChunk(key, new Blob([parts[i]]));
      }
    }).catch(function (err) {
      self.onEvent('error', err);
    });
  };

  PeerLink.prototype._finishIncoming = async function (id) {
    var entry = this.incoming.get(id);
    if (!entry) return;
    try {
      var blob;
      if (!entry.flushed && entry.bufferedBytes < FLUSH_AT) {
        blob = new Blob(entry.parts);
      } else {
        this._flush(entry);
        await entry.chain;
        var chunks = await Store.readChunks(id + ':');
        blob = new Blob(chunks);
      }
      if (blob.size !== entry.meta.size) {
        throw new Error('Размер файла не совпал: ' + entry.meta.name);
      }
      var hash = await sha256Blob(blob);
      if (hash !== entry.meta.hash) {
        throw new Error('Контрольная сумма не совпала: ' + entry.meta.name);
      }
      var meta = Object.assign({}, entry.meta, { addedAt: Date.now() });
      await Store.putFile(meta, blob);
      if (entry.flushed) await Store.deleteChunks(id + ':');
      this.incoming.delete(id);
      this.requested.delete(id);
      this.remote.files.set(meta.id, meta);
      this.send({ t: 'file-done', id: id, ok: true });
      this.onEvent('progress', { id: id, dir: 'in', name: meta.name, loaded: meta.size, total: meta.size, status: 'done' });
      this.onEvent('file', { meta: meta });
    } catch (err) {
      this.incoming.delete(id);
      try { await Store.deleteChunks(id + ':'); } catch (e) {}
      this.send({ t: 'file-done', id: id, ok: false, error: String(err.message || err) });
      this.onEvent('progress', { id: id, dir: 'in', name: entry.meta.name, loaded: entry.bytes, total: entry.meta.size, status: 'error' });
      this.onEvent('error', err);
    }
  };

  global.MeshNet = {
    CHUNK_SIZE: CHUNK_SIZE,
    SIGNAL_TTL: SIGNAL_TTL,
    b64uEncode: b64uEncode,
    b64uDecode: b64uDecode,
    randomId: randomId,
    packSignal: packSignal,
    unpackSignal: unpackSignal,
    pinFrom: pinFrom,
    buildIceServers: buildIceServers,
    createPC: createPC,
    waitIce: waitIce,
    PeerLink: PeerLink
  };
})(window);
