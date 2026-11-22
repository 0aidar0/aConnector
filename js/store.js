/* Хранилище: IndexedDB (метаданные, файлы, временные чанки). */
(function (global) {
  'use strict';

  var DB_NAME = 'meshdrop';
  var DB_VERSION = 1;
  var dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
        if (!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks');
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
      req.onblocked = function () { reject(new Error('База данных заблокирована другой вкладкой')); };
    });
    return dbPromise;
  }

  function done(tx) {
    return new Promise(function (resolve, reject) {
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error || new Error('Ошибка IndexedDB')); };
      tx.onabort = function () { reject(tx.error || new Error('Транзакция отменена')); };
    });
  }

  function reqValue(req) {
    return new Promise(function (resolve, reject) {
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  var Store = {
    async listFiles() {
      var db = await openDB();
      return reqValue(db.transaction('files', 'readonly').objectStore('files').getAll());
    },

    async putFile(meta, blob) {
      var db = await openDB();
      var tx = db.transaction(['files', 'blobs'], 'readwrite');
      tx.objectStore('files').put(meta);
      tx.objectStore('blobs').put(blob, meta.id);
      await done(tx);
    },

    async getFile(id) {
      var db = await openDB();
      var tx = db.transaction(['files', 'blobs'], 'readonly');
      var meta = await reqValue(tx.objectStore('files').get(id));
      if (!meta) return null;
      var blob = await reqValue(tx.objectStore('blobs').get(id));
      if (!blob) return null;
      return { meta: meta, blob: blob };
    },

    async deleteFile(id) {
      var db = await openDB();
      var tx = db.transaction(['files', 'blobs', 'chunks'], 'readwrite');
      var finished = done(tx);
      tx.objectStore('files').delete(id);
      tx.objectStore('blobs').delete(id);
      await this._deleteChunksInTx(tx.objectStore('chunks'), id + ':');
      await finished;
    },

    async putChunk(key, blob) {
      var db = await openDB();
      var tx = db.transaction('chunks', 'readwrite');
      tx.objectStore('chunks').put(blob, key);
      await done(tx);
    },

    async readChunks(prefix) {
      var db = await openDB();
      var store = db.transaction('chunks', 'readonly').objectStore('chunks');
      var range = IDBKeyRange.bound(prefix, prefix + '\uffff');
      return reqValue(store.getAll(range));
    },

    async deleteChunks(prefix) {
      var db = await openDB();
      var tx = db.transaction('chunks', 'readwrite');
      var finished = done(tx);
      await this._deleteChunksInTx(tx.objectStore('chunks'), prefix);
      await finished;
    },

    _deleteChunksInTx(store, prefix) {
      return new Promise(function (resolve, reject) {
        var range = IDBKeyRange.bound(prefix, prefix + '\uffff');
        var req = store.openCursor(range);
        req.onsuccess = function () {
          var cur = req.result;
          if (!cur) { resolve(); return; }
          cur.delete();
          cur.continue();
        };
        req.onerror = function () { reject(req.error); };
      });
    },

    async getMeta(key, fallback) {
      var db = await openDB();
      var value = await reqValue(db.transaction('meta', 'readonly').objectStore('meta').get(key));
      return value === undefined ? fallback : value;
    },

    async setMeta(key, value) {
      var db = await openDB();
      var tx = db.transaction('meta', 'readwrite');
      tx.objectStore('meta').put(value, key);
      await done(tx);
    },

    async clearAll() {
      var db = await openDB();
      var tx = db.transaction(['files', 'blobs', 'chunks', 'meta'], 'readwrite');
      tx.objectStore('files').clear();
      tx.objectStore('blobs').clear();
      tx.objectStore('chunks').clear();
      tx.objectStore('meta').clear();
      await done(tx);
    },

    async estimate() {
      if (!navigator.storage || !navigator.storage.estimate) return null;
      try { return await navigator.storage.estimate(); } catch (e) { return null; }
    },

    async persist() {
      if (!navigator.storage || !navigator.storage.persist) return false;
      try { return await navigator.storage.persist(); } catch (e) { return false; }
    }
  };

  global.Store = Store;
})(window);
