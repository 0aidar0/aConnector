/* MeshDrop — общая папка напрямую между двумя устройствами. */
(function () {
  'use strict';

  var $ = function (sel) { return document.querySelector(sel); };
  var SIGNAL_TTL = MeshNet.SIGNAL_TTL;

  var el = {};
  var state = {
    settings: null,
    local: new Map(),
    tombstones: new Set(),
    link: null,
    pc: null,
    dc: null,
    role: null,
    invite: null,
    answer: null,
    timer: null,
    countdown: null,
    connectTimer: null,
    expired: false,
    connected: false,
    busy: false,
    transfers: new Map(),
    autoSync: true,
    scan: null,
    filter: '',
    pasteCb: null
  };

  /* ================= настройки ================= */

  function defaultSettings() {
    return {
      name: '',
      stun: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'],
      turnUrl: '',
      turnUser: '',
      turnPass: '',
      autosync: true
    };
  }

  function loadSettings() {
    var saved = {};
    try { saved = JSON.parse(localStorage.getItem('meshdrop.settings') || '{}'); } catch (e) {}
    var out = Object.assign(defaultSettings(), saved);
    if (!out.name) out.name = 'Устройство ' + Math.floor(1000 + Math.random() * 9000);
    if (!Array.isArray(out.stun) || !out.stun.length) out.stun = defaultSettings().stun;
    return out;
  }

  function saveSettings() {
    try { localStorage.setItem('meshdrop.settings', JSON.stringify(state.settings)); } catch (e) {}
  }

  /* ================= утилиты ================= */

  function fmtSize(bytes) {
    if (bytes === 0) return '0 Б';
    if (!bytes || bytes < 0) return '—';
    var units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
    var i = Math.floor(Math.log(bytes) / Math.log(1024));
    i = Math.min(i, units.length - 1);
    var val = bytes / Math.pow(1024, i);
    return (val >= 100 || i === 0 ? Math.round(val) : val.toFixed(1).replace('.', ',')) + ' ' + units[i];
  }

  function plural(n, one, few, many) {
    var mod10 = n % 10, mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return n + ' ' + one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return n + ' ' + few;
    return n + ' ' + many;
  }

  function formatPin(pin) {
    if (!pin) return '— — —';
    return pin.slice(0, 3) + ' ' + pin.slice(3);
  }

  function baseName(path) {
    var i = path.lastIndexOf('/');
    return i >= 0 ? path.slice(i + 1) : path;
  }

  function dirName(path) {
    var i = path.lastIndexOf('/');
    return i > 0 ? path.slice(0, i) : '';
  }

  function extLabel(name) {
    var base = baseName(name);
    var i = base.lastIndexOf('.');
    if (i <= 0 || i === base.length - 1) return 'FILE';
    return base.slice(i + 1, i + 5);
  }

  function initial(name) {
    if (!name) return '?';
    var t = String(name).trim();
    return t ? t.charAt(0).toUpperCase() : '?';
  }

  function normalizeName(path) {
    var p = String(path || '').replace(/\\/g, '/').replace(/^\/+/, '');
    var parts = [];
    p.split('/').forEach(function (part) {
      if (!part || part === '.') return;
      if (part === '..') { parts.pop(); return; }
      parts.push(part);
    });
    return parts.join('/') || 'file';
  }

  function publicMeta(meta) {
    return {
      id: meta.id,
      name: meta.name,
      size: meta.size,
      type: meta.type || '',
      hash: meta.hash,
      mtime: meta.mtime || 0
    };
  }

  function sdpHasCandidates(sdp) {
    return /(^|\r\n)a=candidate:/.test(sdp || '');
  }

  function toast(message, kind) {
    var t = document.createElement('div');
    t.className = 'toast' + (kind ? ' ' + kind : '');
    t.textContent = message;
    el.toasts.appendChild(t);
    setTimeout(function () {
      t.style.opacity = '0';
      t.style.transform = 'translateY(6px)';
      t.style.transition = '.25s';
      setTimeout(function () { t.remove(); }, 280);
    }, kind === 'error' ? 6500 : 3800);
  }

  function updateStatus(text, kind) {
    el.netStatus.className = 'pill' + (kind ? ' ' + kind : '');
    el.netStatus.querySelector('span').textContent = text;
  }

  function setView(name) {
    document.body.dataset.view = name;
    el.viewConnect.hidden = name !== 'connect';
    el.viewSession.hidden = name !== 'session';
  }

  function showModal(id) {
    var m = document.getElementById(id);
    if (m) m.hidden = false;
  }

  function hideModal(id) {
    var m = document.getElementById(id);
    if (m) m.hidden = true;
    if (id === 'modal-confirm' && state.confirmResolve) {
      var r = state.confirmResolve;
      state.confirmResolve = null;
      r(null);
    }
  }

  function askChoice(opts) {
    return new Promise(function (resolve) {
      el.confirmTitle.textContent = opts.title;
      el.confirmText.textContent = opts.text || '';
      el.confirmActions.textContent = '';
      (opts.options || []).forEach(function (opt) {
        var b = document.createElement('button');
        b.className = 'btn ' + (opt.kind || '');
        b.textContent = opt.label;
        b.addEventListener('click', function () {
          state.confirmResolve = null;
          hideModal('modal-confirm');
          resolve(opt.value);
        });
        el.confirmActions.appendChild(b);
      });
      var cancel = document.createElement('button');
      cancel.className = 'btn ghost';
      cancel.textContent = 'Отмена';
      cancel.addEventListener('click', function () {
        state.confirmResolve = null;
        hideModal('modal-confirm');
        resolve(null);
      });
      el.confirmActions.appendChild(cancel);
      state.confirmResolve = resolve;
      showModal('modal-confirm');
    });
  }

  function askConfirm(title, text, okLabel, kind) {
    return askChoice({
      title: title,
      text: text,
      options: [{ label: okLabel || 'OK', value: 'ok', kind: kind || 'primary' }]
    }).then(function (v) { return v === 'ok'; });
  }

  async function copyText(text, okMessage) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        throw new Error('no clipboard');
      }
    } catch (e) {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.top = '-1000px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      } catch (e2) {
        toast('Не удалось скопировать. Выделите текст вручную.', 'error');
        return;
      }
    }
    toast(okMessage || 'Скопировано', 'ok');
  }

  /* ================= отрисовка ================= */

  var renderTimer = null;
  function scheduleRender() {
    if (renderTimer) return;
    renderTimer = setTimeout(function () {
      renderTimer = null;
      renderFiles();
      renderTransfers();
    }, 120);
  }

  function collectEntries() {
    var map = new Map();
    state.local.forEach(function (m, id) {
      map.set(id, Object.assign({}, m, { local: true, remote: false }));
    });
    if (state.link) {
      state.link.remote.files.forEach(function (m, id) {
        var existing = map.get(id);
        if (existing) existing.remote = true;
        else map.set(id, Object.assign({}, m, { local: false, remote: true }));
      });
    }
    return Array.from(map.values());
  }

  function getTransfer(id) {
    return state.transfers.get('in:' + id) || state.transfers.get('out:' + id) || null;
  }

  function renderFiles() {
    var entries = collectEntries();
    var filter = state.filter.toLowerCase();
    if (filter) entries = entries.filter(function (e) { return e.name.toLowerCase().indexOf(filter) >= 0; });
    entries.sort(function (a, b) { return a.name.localeCompare(b.name, 'ru', { numeric: true }); });

    el.fileList.textContent = '';
    el.emptyState.hidden = entries.length > 0;
    el.fileCount.textContent = entries.length ? plural(entries.length, 'элемент', 'элемента', 'элементов') : '';

    entries.forEach(function (entry) {
      el.fileList.appendChild(fileRow(entry));
    });
  }

  function fileRow(entry) {
    var li = document.createElement('li');
    li.className = 'file-item';

    var icon = document.createElement('div');
    icon.className = 'file-icon' + (entry.local ? '' : ' remote');
    icon.textContent = extLabel(entry.name);
    li.appendChild(icon);

    var main = document.createElement('div');
    main.className = 'file-main';

    var nameEl = document.createElement('div');
    nameEl.className = 'file-name';
    nameEl.textContent = baseName(entry.name);
    nameEl.title = entry.name;
    main.appendChild(nameEl);

    var sub = document.createElement('div');
    sub.className = 'file-sub';
    var dir = dirName(entry.name);
    if (dir) {
      var d = document.createElement('span');
      d.textContent = dir;
      sub.appendChild(d);
      var sep = document.createElement('span');
      sep.className = 'sep';
      sub.appendChild(sep);
    }
    var size = document.createElement('span');
    size.textContent = fmtSize(entry.size);
    sub.appendChild(size);

    var badge = document.createElement('span');
    badge.className = 'badge ' + (entry.local && entry.remote ? 'both' : entry.local ? 'local' : 'remote');
    badge.textContent = entry.local && entry.remote ? 'у обоих' : entry.local ? 'здесь' : 'у собеседника';
    sub.appendChild(badge);

    var tr = getTransfer(entry.id);
    if (tr && tr.status === 'active') {
      var busy = document.createElement('span');
      busy.className = 'badge busy';
      busy.textContent = tr.dir === 'in' ? 'получение…' : 'отправка…';
      sub.appendChild(busy);
    }

    main.appendChild(sub);

    if (tr && tr.status === 'active' && tr.total) {
      var progress = document.createElement('div');
      progress.className = 'file-progress';
      var bar = document.createElement('i');
      bar.style.width = Math.min(100, (tr.loaded / tr.total) * 100) + '%';
      progress.appendChild(bar);
      main.appendChild(progress);
    }

    li.appendChild(main);

    var actions = document.createElement('div');
    actions.className = 'file-actions';

    if (!entry.local) {
      var dl = document.createElement('button');
      dl.className = 'mini-btn';
      dl.title = 'Скачать с собеседника';
      dl.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 4v12m0 0-5-5m5 5 5-5"/><path d="M5 20h14"/></svg>';
      dl.addEventListener('click', function () { requestFile(entry); });
      actions.appendChild(dl);
    }

    var del = document.createElement('button');
    del.className = 'mini-btn danger';
    del.title = entry.local ? 'Удалить' : 'Попросить собеседника удалить';
    del.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V5h6v2m-8 0 1 13h8l1-13"/></svg>';
    del.addEventListener('click', function () { deleteFlow(entry); });
    actions.appendChild(del);

    li.appendChild(actions);
    return li;
  }

  function renderTransfers() {
    var items = Array.from(state.transfers.values());
    el.transfersSection.hidden = items.length === 0;
    el.transferList.textContent = '';
    items.sort(function (a, b) { return (b.updated || 0) - (a.updated || 0); });
    items.forEach(function (t) {
      var li = document.createElement('li');
      li.className = 'transfer-item';

      var dir = document.createElement('span');
      dir.className = 't-dir';
      dir.textContent = t.dir === 'in' ? '↓' : '↑';
      li.appendChild(dir);

      var name = document.createElement('span');
      name.className = 't-name';
      name.textContent = baseName(t.name || '');
      name.title = t.name || '';
      li.appendChild(name);

      var barWrap = document.createElement('span');
      barWrap.className = 'transfer-bar';
      var bar = document.createElement('i');
      bar.style.width = (t.total ? Math.min(100, (t.loaded / t.total) * 100) : 0) + '%';
      barWrap.appendChild(bar);
      li.appendChild(barWrap);

      var pct = document.createElement('span');
      pct.className = 't-pct';
      pct.textContent = t.status === 'done' ? 'готово' : t.status === 'sent' ? 'отправлен' : (t.total ? Math.floor((t.loaded / t.total) * 100) + '%' : '');
      li.appendChild(pct);

      el.transferList.appendChild(li);
    });
  }

  async function renderStorage() {
    var est = await Store.estimate();
    if (!est || !est.quota) { el.storageInfo.textContent = ''; return; }
    el.storageInfo.textContent = fmtSize(est.usage || 0) + ' из ' + fmtSize(est.quota);
  }

  /* ================= файлы ================= */

  async function makeFileId(name, size, hash) {
    return (await sha256Text(name + '\u0000' + size + '\u0000' + hash)).slice(0, 32);
  }

  async function addEntries(list) {
    if (!list.length) return;
    if (state.busy) { toast('Дождитесь окончания текущей операции'); return; }
    state.busy = true;
    toast('Обрабатываем ' + plural(list.length, 'файл', 'файла', 'файлов') + '…');
    var added = 0, skipped = 0, failed = 0;
    try {
      for (var i = 0; i < list.length; i++) {
        var file = list[i].file;
        var path = normalizeName(list[i].path || file.name);
        try {
          var hash = await sha256Blob(file);
          var id = await makeFileId(path, file.size, hash);
          if (state.local.has(id)) { skipped++; continue; }
          var meta = {
            id: id,
            name: path,
            size: file.size,
            type: file.type || '',
            hash: hash,
            mtime: file.lastModified || Date.now(),
            addedAt: Date.now()
          };
          await Store.putFile(meta, file);
          state.local.set(id, meta);
          if (state.tombstones.has(id)) {
            state.tombstones.delete(id);
            persistTombstones();
          }
          if (state.link && state.connected) state.link.send({ t: 'add', file: publicMeta(meta) });
          added++;
          if (added % 3 === 0) { renderFiles(); renderStorage(); }
        } catch (err) {
          console.error(err);
          failed++;
        }
      }
    } finally {
      state.busy = false;
    }
    renderFiles();
    renderStorage();
    if (added) toast('Добавлено: ' + plural(added, 'файл', 'файла', 'файлов'), 'ok');
    if (skipped) toast('Уже в папке: ' + skipped);
    if (failed) toast('Не удалось добавить: ' + failed, 'error');
  }

  function entriesFromFileList(files) {
    return Array.from(files || []).map(function (f) {
      return { file: f, path: f.webkitRelativePath || f.relativePath || f.name };
    });
  }

  function walkEntry(entry, prefix, out) {
    return new Promise(function (resolve) {
      if (!entry) { resolve(); return; }
      if (entry.isFile) {
        entry.file(function (file) {
          out.push({ file: file, path: prefix + entry.name });
          resolve();
        }, function () { resolve(); });
        return;
      }
      if (entry.isDirectory) {
        var reader = entry.createReader();
        var all = [];
        var readBatch = function () {
          reader.readEntries(function (batch) {
            if (!batch.length) {
              (async function () {
                for (var i = 0; i < all.length; i++) {
                  await walkEntry(all[i], prefix + entry.name + '/', out);
                }
                resolve();
              })();
              return;
            }
            for (var i = 0; i < batch.length; i++) all.push(batch[i]);
            readBatch();
          }, function () { resolve(); });
        };
        readBatch();
        return;
      }
      resolve();
    });
  }

  async function entriesFromDataTransfer(dt) {
    var items = dt.items ? Array.from(dt.items) : [];
    var roots = items.map(function (it) {
      return it.webkitGetAsEntry ? it.webkitGetAsEntry() : null;
    }).filter(Boolean);
    if (!roots.length) return entriesFromFileList(dt.files);
    var out = [];
    for (var i = 0; i < roots.length; i++) await walkEntry(roots[i], '', out);
    return out;
  }

  async function deleteLocal(id) {
    try { await Store.deleteFile(id); } catch (e) { console.error(e); }
    state.local.delete(id);
    state.tombstones.add(id);
    persistTombstones();
    renderFiles();
    renderStorage();
  }

  async function deleteFlow(entry) {
    var remoteHas = !!(state.link && state.connected && state.link.remote.files.has(entry.id));
    if (entry.local && remoteHas) {
      var choice = await askChoice({
        title: 'Удалить файл?',
        text: '«' + entry.name + '» есть и у собеседника. Удалить только у себя или у обоих?',
        options: [
          { label: 'Удалить только у меня', value: 'me', kind: 'ghost' },
          { label: 'Удалить у обоих', value: 'all', kind: 'danger' }
        ]
      });
      if (!choice) return;
      await deleteLocal(entry.id);
      if (choice === 'all' && state.link && state.connected) {
        state.link.send({ t: 'del', id: entry.id });
        toast('Файл удалён у обоих', 'ok');
      } else {
        toast('Файл удалён на этом устройстве');
      }
      return;
    }
    if (entry.local) {
      var ok = await askConfirm('Удалить файл?', '«' + entry.name + '» будет удалён с этого устройства.', 'Удалить', 'danger');
      if (!ok) return;
      await deleteLocal(entry.id);
      toast('Файл удалён');
      return;
    }
    if (remoteHas) {
      var ask = await askConfirm(
        'Удалить у собеседника?',
        'Файл хранится только у собеседника. Отправить запрос на удаление?',
        'Удалить у собеседника',
        'danger'
      );
      if (ask && state.link) {
        state.link.send({ t: 'del', id: entry.id });
        toast('Запрос на удаление отправлен');
      }
    }
  }

  function requestFile(entry) {
    if (!state.link || !state.connected) { toast('Нет соединения', 'error'); return; }
    if (state.tombstones.has(entry.id)) {
      state.tombstones.delete(entry.id);
      persistTombstones();
    }
    state.link.request(entry.id);
    toast('Запрашиваем файл…');
  }

  function persistTombstones() {
    Store.setMeta('tombstones', Array.from(state.tombstones)).catch(function () {});
  }

  function maybeAutoPull(file) {
    if (!state.autoSync || !state.link || !state.connected || !file || !file.id) return;
    if (state.local.has(file.id)) return;
    if (state.tombstones.has(file.id)) return;
    if (state.transfers.has('in:' + file.id)) return;
    state.link.request(file.id);
  }

  /* ================= передачи ================= */

  function updateTransfer(p) {
    var key = p.dir + ':' + p.id;
    var cur = state.transfers.get(key) || {
      id: p.id, dir: p.dir, name: p.name, loaded: 0, total: p.total, status: 'active'
    };
    cur.name = p.name || cur.name;
    cur.loaded = p.loaded || 0;
    cur.total = p.total || 0;
    cur.status = p.status || 'active';
    cur.updated = Date.now();
    state.transfers.set(key, cur);

    if (cur.status === 'done' || cur.status === 'sent') {
      setTimeout(function () {
        var t = state.transfers.get(key);
        if (t && (t.status === 'done' || t.status === 'sent')) {
          state.transfers.delete(key);
          scheduleRender();
        }
      }, 5000);
    }
    scheduleRender();
  }

  /* ================= P2P ================= */

  function wirePC(pc) {
    pc.addEventListener('connectionstatechange', function () {
      if (pc !== state.pc) return;
      var s = pc.connectionState;
      console.info('[meshdrop] connection', s, 'ice=' + pc.iceConnectionState, 'gather=' + pc.iceGatheringState);
      if (s === 'failed') {
        updateStatus('ошибка соединения', 'warn');
        toast('Не удалось установить соединение. Попробуйте новый код; если сети сложные — добавьте TURN в настройках.', 'error');
      } else if (s === 'disconnected') {
        updateStatus('связь прерывается…', 'warn');
      }
    });
  }

  function attachChannel(pc, dc) {
    state.dc = dc;
    dc.onopen = function () {
      if (state.dc !== dc) return;
      var link = new MeshNet.PeerLink(dc, {
        name: state.settings.name,
        getManifest: function () {
          return Array.from(state.local.values()).map(publicMeta);
        },
        getFile: function (id) { return Store.getFile(id); },
        onEvent: onLinkEvent
      });
      state.link = link;
      enterSession();
    };
  }

  function onLinkEvent(ev, data) {
    if (ev === 'hello') {
      el.peerName.textContent = data.name || 'Собеседник';
      el.peerAvatar.textContent = initial(data.name);
      el.peerSub.textContent = data.files.length
        ? plural(data.files.length, 'файл', 'файла', 'файлов') + ' у собеседника'
        : 'папка собеседника пуста';
      data.files.forEach(maybeAutoPull);
      scheduleRender();
      return;
    }
    if (ev === 'manifest') {
      data.files.forEach(maybeAutoPull);
      scheduleRender();
      return;
    }
    if (ev === 'add') {
      maybeAutoPull(data.file);
      scheduleRender();
      return;
    }
    if (ev === 'del') {
      handleRemoteDelete(data.id);
      return;
    }
    if (ev === 'progress') {
      updateTransfer(data);
      return;
    }
    if (ev === 'file') {
      state.local.set(data.meta.id, data.meta);
      if (state.tombstones.has(data.meta.id)) {
        state.tombstones.delete(data.meta.id);
        persistTombstones();
      }
      renderFiles();
      renderStorage();
      return;
    }
    if (ev === 'delivered') {
      if (!data.ok) toast('Файл не доставлен: ' + (data.error || 'ошибка'), 'error');
      return;
    }
    if (ev === 'nofile') {
      toast('Файл больше недоступен у собеседника', 'error');
      return;
    }
    if (ev === 'error') {
      toast(data && data.message ? data.message : String(data), 'error');
      return;
    }
    if (ev === 'close') {
      onUnexpectedClose();
    }
  }

  async function handleRemoteDelete(id) {
    var name = state.local.has(id) ? state.local.get(id).name : '';
    if (state.local.has(id)) {
      try { await Store.deleteFile(id); } catch (e) {}
      state.local.delete(id);
      state.tombstones.add(id);
      persistTombstones();
      renderFiles();
      renderStorage();
    }
    if (name) toast('Собеседник удалил: ' + baseName(name));
  }

  function onUnexpectedClose() {
    if (!state.connected) return;
    closeConnection();
    toast('Собеседник отключился', 'error');
  }

  function enterSession() {
    state.connected = true;
    state.busy = false;
    stopCountdown();
    state.expired = false;
    el.hostPanel.hidden = true;
    el.guestPanel.hidden = true;
    el.guestWaiting.hidden = true;
    el.btnHost.textContent = 'Создать приглашение';
    el.btnHost.disabled = false;
    el.peerName.textContent = (state.link && state.link.remote.name) || 'Собеседник';
    el.peerAvatar.textContent = initial(state.link && state.link.remote.name);
    el.peerSub.textContent = 'канал установлен';
    setView('session');
    updateStatus('подключено', 'online');
    toast('Соединение установлено', 'ok');
    renderFiles();
    renderStorage();
    if (state.link) {
      // Если у собеседника уже есть файлы — подтягиваем недостающие.
      state.link.remote.files.forEach(maybeAutoPull);
    }
  }

  function closeConnection() {
    state.connected = false;
    stopCountdown();
    state.expired = false;
    state.role = null;
    state.invite = null;
    state.answer = null;

    var link = state.link; state.link = null;
    var dc = state.dc; state.dc = null;
    var pc = state.pc; state.pc = null;
    if (link) { try { link.close(); } catch (e) {} }
    if (dc) { try { dc.close(); } catch (e) {} }
    if (pc) { try { pc.close(); } catch (e) {} }

    state.transfers.clear();
    el.hostPanel.hidden = true;
    el.guestPanel.hidden = true;
    el.guestWaiting.hidden = true;
    el.hostExpired.hidden = true;
    el.guestExpired.hidden = true;
    el.btnHost.disabled = false;
    el.btnHost.textContent = 'Создать приглашение';
    el.btnHostScan.disabled = false;
    el.btnHostPaste.disabled = false;
    el.btnGuestCopy.disabled = false;
    setView('connect');
    updateStatus('не подключено', '');
    renderFiles();
    renderTransfers();
  }

  function disconnect() {
    var was = state.connected;
    closeConnection();
    if (was) toast('Соединение закрыто');
  }

  /* ================= приглашение ================= */

  async function createInvite() {
    if (state.busy) return;
    state.busy = true;
    closeConnection();
    state.role = 'host';
    state.expired = false;
    el.hostPanel.hidden = false;
    el.guestPanel.hidden = true;
    el.btnHost.disabled = true;
    el.btnHost.textContent = 'Создаём приглашение…';
    el.hostExpired.hidden = true;

    try {
      var pc = MeshNet.createPC(state.settings);
      state.pc = pc;
      wirePC(pc);
      var dc = pc.createDataChannel('meshdrop', { ordered: true });
      attachChannel(pc, dc);

      var offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await MeshNet.waitIce(pc);
      if (!pc.localDescription) throw new Error('не удалось создать offer');

      var id = MeshNet.randomId();
      var ts = Date.now();
      var payload = await MeshNet.packSignal({ v: 1, t: 'offer', id: id, ts: ts, sdp: pc.localDescription.sdp });
      var pin = await MeshNet.pinFrom(id);

      state.invite = { id: id, ts: ts, payload: payload, pin: pin };
      drawQR(el.hostQr, payload);
      el.hostCode.value = payload;
      el.hostPin.textContent = formatPin(pin);
      startCountdown('host', ts);
      updateStatus('ожидаем подключение', 'warn');
      if (!sdpHasCandidates(pc.localDescription.sdp)) {
        toast('Сеть не выдала ни одного ICE-адреса. Соединение может не установиться: проверьте VPN/файрвол или добавьте TURN-сервер в настройках.', 'error');
      }
    } catch (err) {
      console.error(err);
      toast('Не удалось создать приглашение: ' + (err.message || err), 'error');
      closeConnection();
    } finally {
      state.busy = false;
      el.btnHost.disabled = false;
      if (!state.connected) el.btnHost.textContent = state.invite ? 'Новое приглашение' : 'Создать приглашение';
    }
  }

  async function applyAnswer(text) {
    if (!state.pc || !state.invite) throw new Error('Сначала создайте приглашение');
    if (state.expired) throw new Error('Код приглашения истёк — создайте новый');
    var data = await MeshNet.unpackSignal(text);
    if (data.t !== 'answer') throw new Error('Это не ответ на приглашение');
    if (data.echo !== state.invite.id) throw new Error('Ответ относится к другому приглашению');
    if (Date.now() - data.ts > SIGNAL_TTL) throw new Error('Код ответа истёк — попросите собеседника подключиться заново');
    await state.pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
    updateStatus('устанавливаем соединение…', 'warn');
    toast('Ответ принят, соединяемся…');
  }

  async function joinWithPayload(text) {
    if (state.busy) return;
    state.busy = true;
    try {
      var data = await MeshNet.unpackSignal(text);
      if (data.t !== 'offer') throw new Error('Это не код приглашения');
      var age = Date.now() - data.ts;
      if (age > SIGNAL_TTL) throw new Error('Код истёк (действует 2 минуты) — попросите создать новый');
      if (age < -60000) throw new Error('Похоже, на устройствах разное время');

      closeConnection();
      state.role = 'guest';
      el.guestPanel.hidden = false;
      el.guestWaiting.hidden = false;
      el.hostPanel.hidden = true;
      el.guestExpired.hidden = true;

      var pc = MeshNet.createPC(state.settings);
      state.pc = pc;
      wirePC(pc);
      pc.ondatachannel = function (e) { attachChannel(pc, e.channel); };

      await pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
      var answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await MeshNet.waitIce(pc);
      if (!pc.localDescription) throw new Error('не удалось создать answer');

      var payload = await MeshNet.packSignal({
        v: 1, t: 'answer', id: MeshNet.randomId(), echo: data.id, ts: Date.now(), sdp: pc.localDescription.sdp
      });
      var pin = await MeshNet.pinFrom(data.id);

      state.answer = { payload: payload, pin: pin };
      drawQR(el.guestQr, payload);
      el.guestCode.value = payload;
      el.guestPin.textContent = formatPin(pin);
      startCountdown('guest', Date.now());
      updateStatus('ожидаем подтверждение', 'warn');
      toast('Покажите QR первому устройству или передайте код ответа', 'ok');
      if (!sdpHasCandidates(data.sdp)) {
        toast('В приглашении нет сетевых адресов. Возможно, соединение не установится — попросите создать новый код.', 'error');
      }
    } catch (err) {
      console.error(err);
      toast(err && err.message ? err.message : 'Не удалось подключиться', 'error');
      closeConnection();
    } finally {
      state.busy = false;
    }
  }

  /* ================= таймер кода ================= */

  function startCountdown(prefix, ts) {
    stopCountdown();
    state.countdown = { prefix: prefix, ts: ts };
    state.expired = false;
    el.hostExpired.hidden = true;
    el.guestExpired.hidden = true;
    el.btnHostScan.disabled = false;
    el.btnHostPaste.disabled = false;
    el.btnGuestCopy.disabled = false;

    var timerEl = prefix === 'host' ? el.hostTimer : el.guestTimer;
    var barEl = prefix === 'host' ? el.hostTimerBar : el.guestTimerBar;
    var barWrap = barEl.parentElement;

    function tick() {
      if (!state.countdown || state.countdown.prefix !== prefix) return;
      var left = Math.max(0, ts + SIGNAL_TTL - Date.now());
      var sec = Math.ceil(left / 1000);
      timerEl.textContent = Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
      barEl.style.width = (left / SIGNAL_TTL * 100) + '%';
      barWrap.classList.toggle('low', left < 30000);
      if (left <= 0) {
        stopCountdown();
        onCountdownExpire(prefix);
      }
    }
    tick();
    state.timer = setInterval(tick, 250);
  }

  function stopCountdown() {
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
    state.countdown = null;
  }

  function onCountdownExpire(prefix) {
    state.expired = true;
    if (prefix === 'host') {
      el.hostExpired.hidden = false;
      el.btnHostScan.disabled = true;
      el.btnHostPaste.disabled = true;
      updateStatus('код истёк', 'warn');
    } else {
      el.guestExpired.hidden = false;
      el.btnGuestCopy.disabled = true;
      el.guestWaiting.hidden = true;
      updateStatus('код истёк', 'warn');
    }
  }

  /* ================= QR ================= */

  function drawQR(canvas, text) {
    try {
      MeshQR.draw(canvas, text);
      return true;
    } catch (err) {
      console.error(err);
      var ctx = canvas.getContext('2d');
      canvas.width = 360;
      canvas.height = 360;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, 360, 360);
      ctx.fillStyle = '#111';
      ctx.font = '15px sans-serif';
      ctx.fillText('QR-код слишком большой', 40, 165);
      ctx.font = '13px sans-serif';
      ctx.fillText('используйте текстовый код', 65, 190);
      return false;
    }
  }

  function openScanner(cb) {
    if (state.scan) closeScanner();
    state.scan = { cb: cb, stream: null, timer: null };
    showModal('modal-scan');
    el.scanHint.textContent = 'Наведите камеру на QR-код на другом устройстве.';
    startCamera();
  }

  async function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      el.scanHint.textContent = 'Камера недоступна (нужен HTTPS или localhost). Загрузите скриншот QR или вставьте код вручную.';
      return;
    }
    try {
      var stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false
      });
      if (!state.scan) {
        stream.getTracks().forEach(function (t) { t.stop(); });
        return;
      }
      state.scan.stream = stream;
      el.scanVideo.srcObject = stream;
      await el.scanVideo.play();
      scanLoop();
    } catch (err) {
      el.scanHint.textContent = 'Нет доступа к камере (' + (err.name || 'ошибка') + '). Загрузите скриншот QR или вставьте код вручную.';
    }
  }

  function scanLoop() {
    if (!state.scan) return;
    var video = el.scanVideo;
    try {
      if (video.readyState >= 2 && video.videoWidth) {
        var canvas = el.scanCanvas;
        var w = video.videoWidth;
        var h = video.videoHeight;
        canvas.width = w;
        canvas.height = h;
        var ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(video, 0, 0, w, h);
        var img = ctx.getImageData(0, 0, w, h);
        var res = MeshQR.decode(img);
        if (res && res.data) {
          finishScan(res.data);
          return;
        }
      }
    } catch (e) { /* кадр может быть не готов */ }
    state.scan.timer = setTimeout(scanLoop, 160);
  }

  function finishScan(text) {
    var cb = state.scan && state.scan.cb;
    closeScanner();
    if (cb) {
      Promise.resolve().then(function () { return cb(text); }).catch(function (e) {
        toast(e && e.message ? e.message : String(e), 'error');
      });
    }
  }

  function closeScanner() {
    if (!state.scan) { hideModal('modal-scan'); return; }
    clearTimeout(state.scan.timer);
    if (state.scan.stream) {
      state.scan.stream.getTracks().forEach(function (t) { t.stop(); });
    }
    el.scanVideo.srcObject = null;
    state.scan = null;
    hideModal('modal-scan');
  }

  async function decodeImageFile(file) {
    var canvas = el.scanCanvas;
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    var w, h;
    if (typeof createImageBitmap === 'function') {
      var bmp = await createImageBitmap(file);
      w = bmp.width;
      h = bmp.height;
      canvas.width = w;
      canvas.height = h;
      ctx.drawImage(bmp, 0, 0);
      if (bmp.close) bmp.close();
    } else {
      var url = URL.createObjectURL(file);
      try {
        var img = await new Promise(function (resolve, reject) {
          var im = new Image();
          im.onload = function () { resolve(im); };
          im.onerror = reject;
          im.src = url;
        });
        w = img.naturalWidth;
        h = img.naturalHeight;
        canvas.width = w;
        canvas.height = h;
        ctx.drawImage(img, 0, 0);
      } finally {
        URL.revokeObjectURL(url);
      }
    }
    var data = ctx.getImageData(0, 0, w, h);
    return MeshQR.decode(data);
  }

  /* ================= модальные окна ================= */

  function openPaste(title, hint, cb) {
    state.pasteCb = cb;
    el.pasteTitle.textContent = title;
    el.pasteHint.textContent = hint;
    el.pasteInput.value = '';
    showModal('modal-paste');
    setTimeout(function () { el.pasteInput.focus(); }, 60);
  }

  function openSettings() {
    var s = state.settings;
    el.setName.value = s.name;
    el.setStun.value = (s.stun || []).join('\n');
    el.setTurnUrl.value = s.turnUrl || '';
    el.setTurnUser.value = s.turnUser || '';
    el.setTurnPass.value = s.turnPass || '';
    showModal('modal-settings');
  }

  function saveSettingsFromForm() {
    state.settings.name = el.setName.value.trim() || ('Устройство ' + Math.floor(1000 + Math.random() * 9000));
    state.settings.stun = el.setStun.value.split(/\n+/).map(function (x) { return x.trim(); }).filter(Boolean);
    state.settings.turnUrl = el.setTurnUrl.value.trim();
    state.settings.turnUser = el.setTurnUser.value.trim();
    state.settings.turnPass = el.setTurnPass.value;
    saveSettings();
    hideModal('modal-settings');
    toast('Настройки сохранены', 'ok');
  }

  /* ================= события ================= */

  function cacheEls() {
    [
      'brand', 'net-status', 'btn-settings',
      'view-connect', 'view-session',
      'btn-host', 'host-panel', 'host-qr', 'host-expired', 'host-pin', 'host-timer', 'host-timer-bar',
      'btn-host-copy', 'btn-host-scan', 'btn-host-paste', 'btn-host-regen', 'host-code', 'btn-host-copy-text',
      'btn-join-scan', 'btn-join-paste', 'guest-panel', 'guest-qr', 'guest-expired', 'guest-pin',
      'guest-timer', 'guest-timer-bar', 'btn-guest-copy', 'btn-guest-cancel', 'guest-code',
      'btn-guest-copy-text', 'guest-waiting',
      'peer-avatar', 'peer-name', 'peer-sub', 'btn-disconnect',
      'file-input', 'dir-input', 'autosync', 'storage-info', 'dropzone', 'filter',
      'file-list', 'file-count', 'empty-state', 'transfers-section', 'transfer-list',
      'toasts', 'modal-paste', 'paste-title', 'paste-hint', 'paste-input', 'paste-apply',
      'modal-scan', 'scan-video', 'scan-canvas', 'scan-hint', 'scan-close', 'scan-file', 'scan-manual',
      'modal-settings', 'set-name', 'set-stun', 'set-turn-url', 'set-turn-user', 'set-turn-pass',
      'settings-save', 'btn-wipe',
      'modal-confirm', 'confirm-title', 'confirm-text', 'confirm-actions', 'foot-note'
    ].forEach(function (id) {
      el[id.replace(/-([a-z])/g, function (_, c) { return c.toUpperCase(); })] = document.getElementById(id);
    });
  }

  function bind() {
    el.btnHost.addEventListener('click', createInvite);
    el.btnHostRegen.addEventListener('click', createInvite);

    el.btnHostCopy.addEventListener('click', function () {
      if (state.invite) copyText(state.invite.payload, 'Код приглашения скопирован');
    });
    el.btnHostCopyText.addEventListener('click', function () {
      if (state.invite) copyText(state.invite.payload, 'Код приглашения скопирован');
    });
    el.btnHostScan.addEventListener('click', function () {
      if (state.expired) { toast('Код истёк — создайте новый', 'error'); return; }
      openScanner(applyAnswer);
    });
    el.btnHostPaste.addEventListener('click', function () {
      if (state.expired) { toast('Код истёк — создайте новый', 'error'); return; }
      openPaste('Ответ второго устройства', 'Вставьте код ответа, который показан на втором устройстве.', applyAnswer);
    });

    el.btnJoinScan.addEventListener('click', function () { openScanner(joinWithPayload); });
    el.btnJoinPaste.addEventListener('click', function () {
      openPaste('Код приглашения', 'Вставьте код-приглашение с первого устройства.', joinWithPayload);
    });
    el.btnGuestCopy.addEventListener('click', function () {
      if (state.answer) copyText(state.answer.payload, 'Код ответа скопирован');
    });
    el.btnGuestCopyText.addEventListener('click', function () {
      if (state.answer) copyText(state.answer.payload, 'Код ответа скопирован');
    });
    el.btnGuestCancel.addEventListener('click', function () {
      closeConnection();
    });

    el.btnDisconnect.addEventListener('click', disconnect);
    el.btnSettings.addEventListener('click', openSettings);
    el.settingsSave.addEventListener('click', saveSettingsFromForm);

    el.btnWipe.addEventListener('click', async function () {
      var ok = await askConfirm(
        'Очистить все данные?',
        'Все файлы общей папки и настройки будут удалены с этого устройства. У собеседника файлы останутся.',
        'Очистить',
        'danger'
      );
      if (!ok) return;
      try {
        await Store.clearAll();
        state.local.clear();
        state.tombstones.clear();
        renderFiles();
        renderStorage();
        hideModal('modal-settings');
        toast('Данные очищены', 'ok');
      } catch (e) {
        toast('Не удалось очистить: ' + e.message, 'error');
      }
    });

    el.fileInput.addEventListener('change', function () {
      var list = entriesFromFileList(el.fileInput.files);
      el.fileInput.value = '';
      addEntries(list);
    });

    el.dirInput.addEventListener('change', function () {
      var list = entriesFromFileList(el.dirInput.files);
      el.dirInput.value = '';
      addEntries(list);
    });

    el.autosync.addEventListener('change', function () {
      state.autoSync = el.autosync.checked;
      state.settings.autosync = state.autoSync;
      saveSettings();
      if (state.autoSync && state.link) {
        state.link.remote.files.forEach(maybeAutoPull);
      }
    });

    el.filter.addEventListener('input', function () {
      state.filter = el.filter.value.trim();
      renderFiles();
    });

    el.dropzone.addEventListener('dragover', function (e) {
      e.preventDefault();
      el.dropzone.classList.add('drag');
    });
    el.dropzone.addEventListener('dragleave', function () { el.dropzone.classList.remove('drag'); });
    el.dropzone.addEventListener('drop', async function (e) {
      e.preventDefault();
      el.dropzone.classList.remove('drag');
      try {
        var list = await entriesFromDataTransfer(e.dataTransfer);
        addEntries(list);
      } catch (err) {
        toast('Не удалось прочитать перетащенные файлы', 'error');
      }
    });

    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('drop', function (e) {
      if (e.target === el.dropzone || el.dropzone.contains(e.target)) return;
      e.preventDefault();
    });

    el.pasteApply.addEventListener('click', function () {
      var text = el.pasteInput.value.trim();
      if (!text) { toast('Вставьте код', 'error'); return; }
      var cb = state.pasteCb;
      state.pasteCb = null;
      hideModal('modal-paste');
      if (cb) {
        Promise.resolve().then(function () { return cb(text); }).catch(function (e) {
          toast(e && e.message ? e.message : String(e), 'error');
        });
      }
    });

    el.scanClose.addEventListener('click', closeScanner);
    el.scanManual.addEventListener('click', function () {
      var cb = state.scan && state.scan.cb;
      closeScanner();
      if (cb) openPaste('Вставьте код', 'Вставьте код из буфера обмена.', cb);
    });
    el.scanFile.addEventListener('change', async function () {
      var file = el.scanFile.files && el.scanFile.files[0];
      el.scanFile.value = '';
      if (!file) return;
      try {
        var res = await decodeImageFile(file);
        if (res && res.data) finishScan(res.data);
        else toast('QR-код на изображении не найден', 'error');
      } catch (e) {
        toast('Не удалось прочитать изображение', 'error');
      }
    });

    document.querySelectorAll('[data-close]').forEach(function (btn) {
      btn.addEventListener('click', function () { hideModal(btn.getAttribute('data-close')); });
    });
    document.querySelectorAll('.modal').forEach(function (m) {
      m.addEventListener('mousedown', function (e) {
        if (e.target !== m) return;
        if (m.id === 'modal-scan') closeScanner();
        else hideModal(m.id);
      });
    });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      var open = document.querySelector('.modal:not([hidden])');
      if (!open) return;
      if (open.id === 'modal-scan') closeScanner();
      else hideModal(open.id);
    });

    el.brand.addEventListener('click', function (e) {
      e.preventDefault();
      if (!state.connected) return;
      askConfirm('Выйти?', 'Соединение будет закрыто. Файлы останутся на устройстве.', 'Выйти', 'danger').then(function (ok) {
        if (ok) closeConnection();
      });
    });
  }

  /* ================= старт ================= */

  async function init() {
    cacheEls();
    state.settings = loadSettings();
    saveSettings();
    state.autoSync = state.settings.autosync !== false;
    el.autosync.checked = state.autoSync;

    try {
      var files = await Store.listFiles();
      state.local = new Map(files.map(function (f) { return [f.id, f]; }));
      state.tombstones = new Set(await Store.getMeta('tombstones', []));
    } catch (e) {
      console.error(e);
      toast('Не удалось открыть локальное хранилище. Проверьте, что не включён приватный режим.', 'error');
    }

    bind();
    renderFiles();
    renderStorage();
    Store.persist();
    updateStatus('не подключено', '');
  }

  document.addEventListener('DOMContentLoaded', init);

  // Для отладки из консоли (не влияет на работу приложения).
  window.__meshdrop = { state: state, closeConnection: closeConnection, createInvite: createInvite, startCountdown: startCountdown };
})();
