(function (global) {
  "use strict";

  var DB_NAME = "uir-frame-spool-v1";
  var DB_VERSION = 3;
  var STORES = {
    FRAMES: "frames",
    FRAME_META: "frame_meta",
    SESSION_REFS: "session_refs",
    REPORT_REFS: "report_refs",
    TEXT_DOCS: "text_docs",
    TEXT_REPORT_REFS: "text_report_refs",
    AUDIO_DOCS: "audio_docs",
    AUDIO_REPORT_REFS: "audio_report_refs"
  };

  function noop() {}

  function nowMs() {
    return Date.now();
  }

  function waitMs(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, Math.max(0, Number(ms) || 0));
    });
  }

  function toArray(value) {
    if (Array.isArray(value)) return value;
    if (value instanceof Set) return Array.from(value);
    return [];
  }

  function uniqueStrings(values) {
    var out = [];
    var seen = new Set();
    toArray(values).forEach(function (value) {
      var text = String(value || "").trim();
      if (!text || seen.has(text)) return;
      seen.add(text);
      out.push(text);
    });
    return out;
  }

  function makeKey(a, b) {
    return String(a || "") + ":" + String(b || "");
  }

  function requestToPromise(request) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error || new Error("IndexedDB request failed")); };
    });
  }

  function txDone(tx) {
    return new Promise(function (resolve, reject) {
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error || new Error("IndexedDB transaction failed")); };
      tx.onabort = function () { reject(tx.error || new Error("IndexedDB transaction aborted")); };
    });
  }

  function openCursorAll(source, onRecord) {
    return new Promise(function (resolve, reject) {
      var request = source.openCursor();
      request.onerror = function () { reject(request.error || new Error("Cursor failed")); };
      request.onsuccess = function (event) {
        var cursor = event.target.result;
        if (!cursor) {
          resolve();
          return;
        }
        try {
          onRecord(cursor.value, cursor);
        } catch (err) {
          reject(err);
          return;
        }
        cursor.continue();
      };
    });
  }

  function openCursorByIndex(index, key, onRecord) {
    return new Promise(function (resolve, reject) {
      var request = index.openCursor(IDBKeyRange.only(key));
      request.onerror = function () { reject(request.error || new Error("Cursor by index failed")); };
      request.onsuccess = function (event) {
        var cursor = event.target.result;
        if (!cursor) {
          resolve();
          return;
        }
        try {
          onRecord(cursor.value, cursor);
        } catch (err) {
          reject(err);
          return;
        }
        cursor.continue();
      };
    });
  }

  function dataUrlToBlob(dataUrl) {
    var raw = String(dataUrl || "").trim();
    var match = /^data:([^;,]+)(;base64)?,(.*)$/i.exec(raw);
    if (!match) throw new Error("Invalid data URL payload");
    var mime = match[1] || "image/png";
    var isBase64 = !!match[2];
    var payload = match[3] || "";
    var bytes;
    if (isBase64) {
      var decoded = atob(payload);
      bytes = new Uint8Array(decoded.length);
      for (var i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
    } else {
      var decodedUri = decodeURIComponent(payload);
      bytes = new TextEncoder().encode(decodedUri);
    }
    return new Blob([bytes], { type: mime });
  }

  function bytesToDataUrl(bytes, mime) {
    var safeMime = String(mime || "image/png").trim() || "image/png";
    var chunkSize = 0x8000;
    var binary = "";
    for (var i = 0; i < bytes.length; i += chunkSize) {
      var chunk = bytes.subarray(i, Math.min(bytes.length, i + chunkSize));
      binary += String.fromCharCode.apply(null, chunk);
    }
    return "data:" + safeMime + ";base64," + btoa(binary);
  }

  function blobToDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onerror = function () { reject(reader.error || new Error("Failed to read blob as data URL")); };
      reader.onload = function () { resolve(String(reader.result || "")); };
      reader.readAsDataURL(blob);
    });
  }

  function normalizeRef(raw, fallbackSessionId) {
    if (!raw || typeof raw !== "object") return null;
    var frameId = String(raw.frameId || "").trim();
    if (!frameId) return null;
    var sessionId = String(raw.sessionId || fallbackSessionId || "").trim();
    return {
      frameId: frameId,
      sessionId: sessionId,
      mime: String(raw.mime || "image/png"),
      createdAtMs: Number(raw.createdAtMs) || nowMs(),
      width: Number(raw.width) || null,
      height: Number(raw.height) || null
    };
  }

  function normalizeTextRef(raw) {
    if (!raw || typeof raw !== "object") return null;
    var docId = String(raw.docId || "").trim();
    if (!docId) return null;
    var mime = String(raw.mime || "text/plain").trim() || "text/plain";
    return {
      docId: docId,
      mime: mime,
      byteLength: Number(raw.byteLength) || 0,
      createdAtMs: Number(raw.createdAtMs) || nowMs()
    };
  }

  function createFrameId() {
    return "frm_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  function createTextDocId() {
    return "txt_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  function createAudioDocId() {
    return "aud_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  function FrameSpoolService(options) {
    var opts = options || {};
    this.captureQueueMax = Math.max(1, Number(opts.captureQueueMax) || 6);
    this.processQueueMax = Math.max(1, Number(opts.processQueueMax) || 12);
    this.writeQueueMax = Math.max(1, Number(opts.writeQueueMax) || 18);
    this.captureQueue = [];
    this.processQueue = [];
    this.writeQueue = [];
    this._dbPromise = null;
    this._pumpScheduled = false;
    this._collector2Running = false;
    this._collector3Running = false;
    this._closed = false;
    this._log = typeof opts.log === "function" ? opts.log : noop;
    this._warn = typeof opts.warn === "function" ? opts.warn : noop;
    this.stats = {
      frameCount: 0,
      totalBytes: 0,
      lastGcAtMs: 0
    };
  }

  FrameSpoolService.prototype._logEvent = function (event, payload) {
    try { this._log(event, payload || {}); } catch (_) {}
  };

  FrameSpoolService.prototype._warnEvent = function (event, payload) {
    try { this._warn(event, payload || {}); } catch (_) {}
  };

  FrameSpoolService.prototype._ensureOpen = function () {
    if (this._closed) throw new Error("Frame spool is closed");
  };

  FrameSpoolService.prototype._openDb = function () {
    var self = this;
    self._ensureOpen();
    if (self._dbPromise) return self._dbPromise;
    self._dbPromise = new Promise(function (resolve, reject) {
      var request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onerror = function () { reject(request.error || new Error("Failed to open frame spool DB")); };
      request.onupgradeneeded = function () {
        var db = request.result;
        var frames = db.objectStoreNames.contains(STORES.FRAMES)
          ? request.transaction.objectStore(STORES.FRAMES)
          : db.createObjectStore(STORES.FRAMES, { keyPath: "frameId" });
        if (!frames.indexNames.contains("createdAtMs")) frames.createIndex("createdAtMs", "createdAtMs", { unique: false });
        if (!frames.indexNames.contains("sessionId")) frames.createIndex("sessionId", "sessionId", { unique: false });

        var meta = db.objectStoreNames.contains(STORES.FRAME_META)
          ? request.transaction.objectStore(STORES.FRAME_META)
          : db.createObjectStore(STORES.FRAME_META, { keyPath: "frameId" });
        if (!meta.indexNames.contains("createdAtMs")) meta.createIndex("createdAtMs", "createdAtMs", { unique: false });
        if (!meta.indexNames.contains("sessionId")) meta.createIndex("sessionId", "sessionId", { unique: false });

        var sessionRefs = db.objectStoreNames.contains(STORES.SESSION_REFS)
          ? request.transaction.objectStore(STORES.SESSION_REFS)
          : db.createObjectStore(STORES.SESSION_REFS, { keyPath: "id" });
        if (!sessionRefs.indexNames.contains("sessionId")) sessionRefs.createIndex("sessionId", "sessionId", { unique: false });
        if (!sessionRefs.indexNames.contains("frameId")) sessionRefs.createIndex("frameId", "frameId", { unique: false });

        var reportRefs = db.objectStoreNames.contains(STORES.REPORT_REFS)
          ? request.transaction.objectStore(STORES.REPORT_REFS)
          : db.createObjectStore(STORES.REPORT_REFS, { keyPath: "id" });
        if (!reportRefs.indexNames.contains("reportId")) reportRefs.createIndex("reportId", "reportId", { unique: false });
        if (!reportRefs.indexNames.contains("frameId")) reportRefs.createIndex("frameId", "frameId", { unique: false });

        var textDocs = db.objectStoreNames.contains(STORES.TEXT_DOCS)
          ? request.transaction.objectStore(STORES.TEXT_DOCS)
          : db.createObjectStore(STORES.TEXT_DOCS, { keyPath: "docId" });
        if (!textDocs.indexNames.contains("createdAtMs")) textDocs.createIndex("createdAtMs", "createdAtMs", { unique: false });
        if (!textDocs.indexNames.contains("mime")) textDocs.createIndex("mime", "mime", { unique: false });

        var textReportRefs = db.objectStoreNames.contains(STORES.TEXT_REPORT_REFS)
          ? request.transaction.objectStore(STORES.TEXT_REPORT_REFS)
          : db.createObjectStore(STORES.TEXT_REPORT_REFS, { keyPath: "id" });
        if (!textReportRefs.indexNames.contains("reportId")) textReportRefs.createIndex("reportId", "reportId", { unique: false });
        if (!textReportRefs.indexNames.contains("docId")) textReportRefs.createIndex("docId", "docId", { unique: false });

        var audioDocs = db.objectStoreNames.contains(STORES.AUDIO_DOCS)
          ? request.transaction.objectStore(STORES.AUDIO_DOCS)
          : db.createObjectStore(STORES.AUDIO_DOCS, { keyPath: "docId" });
        if (!audioDocs.indexNames.contains("createdAtMs")) audioDocs.createIndex("createdAtMs", "createdAtMs", { unique: false });
        if (!audioDocs.indexNames.contains("mime")) audioDocs.createIndex("mime", "mime", { unique: false });

        var audioReportRefs = db.objectStoreNames.contains(STORES.AUDIO_REPORT_REFS)
          ? request.transaction.objectStore(STORES.AUDIO_REPORT_REFS)
          : db.createObjectStore(STORES.AUDIO_REPORT_REFS, { keyPath: "id" });
        if (!audioReportRefs.indexNames.contains("reportId")) audioReportRefs.createIndex("reportId", "reportId", { unique: false });
        if (!audioReportRefs.indexNames.contains("docId")) audioReportRefs.createIndex("docId", "docId", { unique: false });
      };
      request.onsuccess = function () {
        var db = request.result;
        db.onversionchange = function () {
          try { db.close(); } catch (_) {}
          self._dbPromise = null;
        };
        resolve(db);
      };
    });
    return self._dbPromise;
  };

  FrameSpoolService.prototype.init = async function () {
    await this._openDb();
    await this.refreshStats();
    return this;
  };

  FrameSpoolService.prototype.getQueueState = function () {
    return {
      captureQueue: this.captureQueue.length,
      processQueue: this.processQueue.length,
      writeQueue: this.writeQueue.length,
      paused: this.writeQueue.length >= this.writeQueueMax
    };
  };

  FrameSpoolService.prototype._isIdle = function () {
    return (
      this.captureQueue.length === 0 &&
      this.processQueue.length === 0 &&
      this.writeQueue.length === 0 &&
      !this._collector2Running &&
      !this._collector3Running &&
      !this._pumpScheduled
    );
  };

  FrameSpoolService.prototype.waitUntilIdle = async function (options) {
    var opts = options || {};
    var timeoutMs = Math.max(50, Number(opts.timeoutMs) || 2500);
    var pollMs = Math.max(10, Number(opts.pollMs) || 50);
    var start = nowMs();
    while (true) {
      if (this._isIdle()) return true;
      if ((nowMs() - start) >= timeoutMs) return false;
      await waitMs(pollMs);
    }
  };

  FrameSpoolService.prototype.shouldPauseCapture = function () {
    return this.writeQueue.length >= this.writeQueueMax || this.processQueue.length >= this.processQueueMax;
  };

  FrameSpoolService.prototype.enqueueCapture = function (meta, dataUrl) {
    var self = this;
    self._ensureOpen();
    return new Promise(function (resolve, reject) {
      var item = {
        meta: meta && typeof meta === "object" ? meta : {},
        dataUrl: String(dataUrl || ""),
        createdAtMs: nowMs(),
        resolve: resolve,
        reject: reject,
        frameId: createFrameId(),
        blob: null,
        byteLength: 0,
        mime: "image/png"
      };
      if (!item.dataUrl) {
        reject(new Error("Cannot enqueue empty frame payload"));
        return;
      }
      if (self.captureQueue.length >= (self.captureQueueMax * 4)) {
        reject(new Error("Frame capture queue overflow"));
        return;
      }
      self.captureQueue.push(item);
      self._schedulePump();
    });
  };

  FrameSpoolService.prototype.enqueueCaptureImmediate = function (meta, dataUrl) {
    this._ensureOpen();
    var item = {
      meta: meta && typeof meta === "object" ? meta : {},
      dataUrl: String(dataUrl || ""),
      createdAtMs: nowMs(),
      resolve: noop,
      reject: noop,
      frameId: createFrameId(),
      blob: null,
      byteLength: 0,
      mime: "image/png"
    };
    if (!item.dataUrl) throw new Error("Cannot enqueue empty frame payload");
    if (this.captureQueue.length >= (this.captureQueueMax * 4)) {
      throw new Error("Frame capture queue overflow");
    }
    this.captureQueue.push(item);
    this._schedulePump();
    return {
      frameId: item.frameId,
      sessionId: String(item.meta.sessionId || ""),
      mime: String(item.meta.mime || "image/png"),
      createdAtMs: Number(item.meta.createdAtMs) || item.createdAtMs,
      width: Number(item.meta.width) || null,
      height: Number(item.meta.height) || null
    };
  };

  FrameSpoolService.prototype._schedulePump = function () {
    var self = this;
    if (self._pumpScheduled || self._closed) return;
    self._pumpScheduled = true;
    Promise.resolve().then(function () {
      self._pumpScheduled = false;
      self._pump().catch(function (err) {
        self._warnEvent("frame-spool:pump-error", { error: String((err && err.message) || err) });
      });
    });
  };

  FrameSpoolService.prototype._pump = async function () {
    this._drainCollector1();
    await this._drainCollector2();
    await this._drainCollector3();
    if (this.captureQueue.length || this.processQueue.length || this.writeQueue.length) {
      this._schedulePump();
    }
  };

  FrameSpoolService.prototype._drainCollector1 = function () {
    while (this.captureQueue.length && this.processQueue.length < this.processQueueMax) {
      this.processQueue.push(this.captureQueue.shift());
    }
  };

  FrameSpoolService.prototype._drainCollector2 = async function () {
    if (this._collector2Running) return;
    this._collector2Running = true;
    try {
      while (this.processQueue.length && this.writeQueue.length < this.writeQueueMax) {
        var item = this.processQueue.shift();
        try {
          if (!item.frameId) item.frameId = createFrameId();
          item.blob = dataUrlToBlob(item.dataUrl);
          item.dataUrl = "";
          item.mime = String(item.blob.type || "image/png");
          item.byteLength = Number(item.blob.size) || 0;
          item.createdAtMs = Number(item.meta && item.meta.createdAtMs) || item.createdAtMs || nowMs();
          item.sessionId = String((item.meta && item.meta.sessionId) || "");
          item.width = Number(item.meta && item.meta.width) || null;
          item.height = Number(item.meta && item.meta.height) || null;
        } catch (err) {
          item.reject(err);
          continue;
        }
        this.writeQueue.push(item);
      }
    } finally {
      this._collector2Running = false;
    }
  };

  FrameSpoolService.prototype._drainCollector3 = async function () {
    if (this._collector3Running) return;
    this._collector3Running = true;
    try {
      while (this.writeQueue.length) {
        var item = this.writeQueue.shift();
        try {
          var ref = await this._writeFrameItem(item);
          item.resolve(ref);
        } catch (err) {
          item.reject(err);
          this._warnEvent("frame-spool:write-error", { error: String((err && err.message) || err) });
        } finally {
          item.dataUrl = "";
          item.blob = null;
          item.meta = null;
        }
      }
    } finally {
      this._collector3Running = false;
    }
  };

  FrameSpoolService.prototype._writeFrameItem = async function (item) {
    var db = await this._openDb();
    var tx = db.transaction(
      [STORES.FRAMES, STORES.FRAME_META, STORES.SESSION_REFS],
      "readwrite"
    );
    var framesStore = tx.objectStore(STORES.FRAMES);
    var metaStore = tx.objectStore(STORES.FRAME_META);
    var sessionStore = tx.objectStore(STORES.SESSION_REFS);

    var createdAtMs = Number(item.createdAtMs) || nowMs();
    var frameRecord = {
      frameId: item.frameId,
      blob: item.blob,
      mime: item.mime,
      createdAtMs: createdAtMs,
      sessionId: item.sessionId || "",
      width: item.width,
      height: item.height
    };
    var metaRecord = {
      frameId: item.frameId,
      mime: item.mime,
      createdAtMs: createdAtMs,
      sessionId: item.sessionId || "",
      width: item.width,
      height: item.height,
      byteLength: Number(item.byteLength) || 0
    };

    framesStore.put(frameRecord);
    metaStore.put(metaRecord);
    if (item.sessionId) {
      sessionStore.put({
        id: makeKey(item.sessionId, item.frameId),
        sessionId: item.sessionId,
        frameId: item.frameId,
        createdAtMs: createdAtMs
      });
    }

    await txDone(tx);
    this.stats.frameCount += 1;
    this.stats.totalBytes += metaRecord.byteLength;

    return {
      frameId: item.frameId,
      sessionId: item.sessionId || "",
      mime: item.mime,
      createdAtMs: createdAtMs,
      width: item.width,
      height: item.height
    };
  };

  FrameSpoolService.prototype.getFrameBlob = async function (frameId) {
    var key = String(frameId || "").trim();
    if (!key) return null;
    var db = await this._openDb();
    var tx = db.transaction([STORES.FRAMES], "readonly");
    var store = tx.objectStore(STORES.FRAMES);
    var record = await requestToPromise(store.get(key));
    await txDone(tx);
    if (!record || !record.blob) return null;
    return record.blob;
  };

  FrameSpoolService.prototype.getFrameDataUrl = async function (frameId) {
    var blob = await this.getFrameBlob(frameId);
    if (!blob) return "";
    return blobToDataUrl(blob);
  };

  FrameSpoolService.prototype.hasFrame = async function (frameId) {
    var key = String(frameId || "").trim();
    if (!key) return false;
    var db = await this._openDb();
    var tx = db.transaction([STORES.FRAME_META], "readonly");
    var store = tx.objectStore(STORES.FRAME_META);
    var record = await requestToPromise(store.get(key));
    await txDone(tx);
    return !!record;
  };

  FrameSpoolService.prototype.waitForFrame = async function (frameId, options) {
    var key = String(frameId || "").trim();
    if (!key) return false;
    var opts = options || {};
    var timeoutMs = Math.max(50, Number(opts.timeoutMs) || 2000);
    var pollMs = Math.max(10, Number(opts.pollMs) || 80);
    var start = nowMs();
    while (true) {
      var exists = false;
      try {
        exists = await this.hasFrame(key);
      } catch (_) {
        exists = false;
      }
      if (exists) return true;
      if ((nowMs() - start) >= timeoutMs) return false;
      await waitMs(pollMs);
    }
  };

  FrameSpoolService.prototype.getFrameBytes = async function (frameId) {
    var blob = await this.getFrameBlob(frameId);
    if (!blob) return null;
    var buffer = await blob.arrayBuffer();
    return new Uint8Array(buffer);
  };

  FrameSpoolService.prototype.putFrameFromBytes = async function (ref, bytes) {
    var normalized = normalizeRef(ref, "");
    if (!normalized) throw new Error("Invalid frame ref");
    var payload = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    if (!payload.length) throw new Error("Frame payload is empty");

    var db = await this._openDb();
    var tx = db.transaction(
      [STORES.FRAMES, STORES.FRAME_META, STORES.SESSION_REFS],
      "readwrite"
    );
    var framesStore = tx.objectStore(STORES.FRAMES);
    var metaStore = tx.objectStore(STORES.FRAME_META);
    var sessionStore = tx.objectStore(STORES.SESSION_REFS);

    var blob = new Blob([payload], { type: normalized.mime || "image/png" });
    framesStore.put({
      frameId: normalized.frameId,
      blob: blob,
      mime: normalized.mime,
      createdAtMs: normalized.createdAtMs,
      sessionId: normalized.sessionId,
      width: normalized.width,
      height: normalized.height
    });
    metaStore.put({
      frameId: normalized.frameId,
      mime: normalized.mime,
      createdAtMs: normalized.createdAtMs,
      sessionId: normalized.sessionId,
      width: normalized.width,
      height: normalized.height,
      byteLength: payload.length
    });
    if (normalized.sessionId) {
      sessionStore.put({
        id: makeKey(normalized.sessionId, normalized.frameId),
        sessionId: normalized.sessionId,
        frameId: normalized.frameId,
        createdAtMs: normalized.createdAtMs
      });
    }

    await txDone(tx);
    return normalized;
  };

  FrameSpoolService.prototype.linkFrameToReport = async function (reportId, frameId) {
    var report = String(reportId || "").trim();
    var frame = String(frameId || "").trim();
    if (!report || !frame) return;
    var db = await this._openDb();
    var tx = db.transaction([STORES.REPORT_REFS], "readwrite");
    tx.objectStore(STORES.REPORT_REFS).put({
      id: makeKey(report, frame),
      reportId: report,
      frameId: frame,
      createdAtMs: nowMs()
    });
    await txDone(tx);
  };

  FrameSpoolService.prototype.linkFramesToReport = async function (reportId, frameIds) {
    var report = String(reportId || "").trim();
    if (!report) return;
    var frames = uniqueStrings(frameIds);
    if (!frames.length) return;
    var db = await this._openDb();
    var tx = db.transaction([STORES.REPORT_REFS], "readwrite");
    var store = tx.objectStore(STORES.REPORT_REFS);
    var stamp = nowMs();
    frames.forEach(function (frameId) {
      store.put({
        id: makeKey(report, frameId),
        reportId: report,
        frameId: frameId,
        createdAtMs: stamp
      });
    });
    await txDone(tx);
  };

  FrameSpoolService.prototype.removeReportRefs = async function (reportId) {
    var report = String(reportId || "").trim();
    if (!report) return 0;
    var db = await this._openDb();
    var tx = db.transaction([STORES.REPORT_REFS], "readwrite");
    var store = tx.objectStore(STORES.REPORT_REFS);
    var index = store.index("reportId");
    var removed = 0;
    await openCursorByIndex(index, report, function (_value, cursor) {
      cursor.delete();
      removed += 1;
    });
    await txDone(tx);
    return removed;
  };

  FrameSpoolService.prototype.removeReportTextRefs = async function (reportId) {
    var report = String(reportId || "").trim();
    if (!report) return 0;
    var db = await this._openDb();
    var tx = db.transaction([STORES.TEXT_REPORT_REFS], "readwrite");
    var store = tx.objectStore(STORES.TEXT_REPORT_REFS);
    var index = store.index("reportId");
    var removed = 0;
    await openCursorByIndex(index, report, function (_value, cursor) {
      cursor.delete();
      removed += 1;
    });
    await txDone(tx);
    return removed;
  };

  FrameSpoolService.prototype.removeReportAudioRefs = async function (reportId) {
    var report = String(reportId || "").trim();
    if (!report) return 0;
    var db = await this._openDb();
    var tx = db.transaction([STORES.AUDIO_REPORT_REFS], "readwrite");
    var store = tx.objectStore(STORES.AUDIO_REPORT_REFS);
    var index = store.index("reportId");
    var removed = 0;
    await openCursorByIndex(index, report, function (_value, cursor) {
      cursor.delete();
      removed += 1;
    });
    await txDone(tx);
    return removed;
  };

  FrameSpoolService.prototype.removeSessionRefs = async function (sessionId) {
    var session = String(sessionId || "").trim();
    if (!session) return 0;
    var db = await this._openDb();
    var tx = db.transaction([STORES.SESSION_REFS], "readwrite");
    var store = tx.objectStore(STORES.SESSION_REFS);
    var index = store.index("sessionId");
    var removed = 0;
    await openCursorByIndex(index, session, function (_value, cursor) {
      cursor.delete();
      removed += 1;
    });
    await txDone(tx);
    return removed;
  };

  FrameSpoolService.prototype.getReportIds = async function () {
    var db = await this._openDb();
    var tx = db.transaction([STORES.REPORT_REFS], "readonly");
    var store = tx.objectStore(STORES.REPORT_REFS);
    var ids = new Set();
    await openCursorAll(store, function (value) {
      if (!value || !value.reportId) return;
      ids.add(String(value.reportId));
    });
    await txDone(tx);
    return Array.from(ids);
  };

  FrameSpoolService.prototype.syncReportRefs = async function (reportFrameMap) {
    var normalized = new Map();
    if (reportFrameMap instanceof Map) {
      reportFrameMap.forEach(function (frameIds, reportId) {
        var report = String(reportId || "").trim();
        if (!report) return;
        normalized.set(report, uniqueStrings(frameIds));
      });
    } else if (reportFrameMap && typeof reportFrameMap === "object") {
      Object.keys(reportFrameMap).forEach(function (reportId) {
        var report = String(reportId || "").trim();
        if (!report) return;
        normalized.set(report, uniqueStrings(reportFrameMap[reportId]));
      });
    }

    var desired = new Set();
    normalized.forEach(function (frameIds, reportId) {
      frameIds.forEach(function (frameId) {
        desired.add(makeKey(reportId, frameId));
      });
    });

    var db = await this._openDb();
    var tx = db.transaction([STORES.REPORT_REFS], "readwrite");
    var store = tx.objectStore(STORES.REPORT_REFS);
    var existingKeys = new Set();
    await openCursorAll(store, function (value, cursor) {
      var id = String((value && value.id) || cursor.key || "");
      if (!id) return;
      existingKeys.add(id);
      if (!desired.has(id)) cursor.delete();
    });

    var stamp = nowMs();
    desired.forEach(function (id) {
      if (existingKeys.has(id)) return;
      var parts = String(id).split(":");
      var reportId = parts.shift();
      var frameId = parts.join(":");
      store.put({ id: id, reportId: reportId, frameId: frameId, createdAtMs: stamp });
    });

    await txDone(tx);
    return { reportCount: normalized.size, refCount: desired.size };
  };

  FrameSpoolService.prototype.syncReportTextRefs = async function (reportTextMap) {
    var normalized = new Map();
    if (reportTextMap instanceof Map) {
      reportTextMap.forEach(function (docIds, reportId) {
        var report = String(reportId || "").trim();
        if (!report) return;
        normalized.set(report, uniqueStrings(docIds));
      });
    } else if (reportTextMap && typeof reportTextMap === "object") {
      Object.keys(reportTextMap).forEach(function (reportId) {
        var report = String(reportId || "").trim();
        if (!report) return;
        normalized.set(report, uniqueStrings(reportTextMap[reportId]));
      });
    }

    var desired = new Set();
    normalized.forEach(function (docIds, reportId) {
      docIds.forEach(function (docId) {
        desired.add(makeKey(reportId, docId));
      });
    });

    var db = await this._openDb();
    var tx = db.transaction([STORES.TEXT_REPORT_REFS], "readwrite");
    var store = tx.objectStore(STORES.TEXT_REPORT_REFS);
    var existingKeys = new Set();
    await openCursorAll(store, function (value, cursor) {
      var id = String((value && value.id) || cursor.key || "");
      if (!id) return;
      existingKeys.add(id);
      if (!desired.has(id)) cursor.delete();
    });

    var stamp = nowMs();
    desired.forEach(function (id) {
      if (existingKeys.has(id)) return;
      var parts = String(id).split(":");
      var reportId = parts.shift();
      var docId = parts.join(":");
      store.put({ id: id, reportId: reportId, docId: docId, createdAtMs: stamp });
    });

    await txDone(tx);
    return { reportCount: normalized.size, refCount: desired.size };
  };

  FrameSpoolService.prototype.syncReportAudioRefs = async function (reportAudioMap) {
    var normalized = new Map();
    if (reportAudioMap instanceof Map) {
      reportAudioMap.forEach(function (docIds, reportId) {
        var report = String(reportId || "").trim();
        if (!report) return;
        normalized.set(report, uniqueStrings(docIds));
      });
    } else if (reportAudioMap && typeof reportAudioMap === "object") {
      Object.keys(reportAudioMap).forEach(function (reportId) {
        var report = String(reportId || "").trim();
        if (!report) return;
        normalized.set(report, uniqueStrings(reportAudioMap[reportId]));
      });
    }

    var desired = new Set();
    normalized.forEach(function (docIds, reportId) {
      docIds.forEach(function (docId) {
        desired.add(makeKey(reportId, docId));
      });
    });

    var db = await this._openDb();
    var tx = db.transaction([STORES.AUDIO_REPORT_REFS], "readwrite");
    var store = tx.objectStore(STORES.AUDIO_REPORT_REFS);
    var existingKeys = new Set();
    await openCursorAll(store, function (value, cursor) {
      var id = String((value && value.id) || cursor.key || "");
      if (!id) return;
      existingKeys.add(id);
      if (!desired.has(id)) cursor.delete();
    });

    var stamp = nowMs();
    desired.forEach(function (id) {
      if (existingKeys.has(id)) return;
      var parts = String(id).split(":");
      var reportId = parts.shift();
      var docId = parts.join(":");
      store.put({ id: id, reportId: reportId, docId: docId, createdAtMs: stamp });
    });

    await txDone(tx);
    return { reportCount: normalized.size, refCount: desired.size };
  };

  FrameSpoolService.prototype.putTextFromBytes = async function (ref, bytes, meta) {
    var inputRef = ref && typeof ref === "object" ? ref : {};
    var docId = String(inputRef.docId || "").trim() || createTextDocId();
    var mime = String(inputRef.mime || "text/plain").trim() || "text/plain";
    var createdAtMs = Number(inputRef.createdAtMs) || nowMs();
    var payload = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    if (!payload.length) throw new Error("Text payload is empty");
    var details = meta && typeof meta === "object" ? meta : {};
    var fileName = String(details.fileName || "").trim();
    var fileType = String(details.fileType || "").trim();
    var preview = String(details.preview || "").slice(0, 240);

    var db = await this._openDb();
    var tx = db.transaction([STORES.TEXT_DOCS], "readwrite");
    var store = tx.objectStore(STORES.TEXT_DOCS);
    store.put({
      docId: docId,
      blob: new Blob([payload], { type: mime }),
      mime: mime,
      createdAtMs: createdAtMs,
      byteLength: payload.length,
      fileName: fileName,
      fileType: fileType,
      preview: preview
    });
    await txDone(tx);

    return {
      docId: docId,
      mime: mime,
      byteLength: payload.length,
      createdAtMs: createdAtMs
    };
  };

  FrameSpoolService.prototype.putAudioFromBytes = async function (ref, bytes, meta) {
    var inputRef = ref && typeof ref === "object" ? ref : {};
    var docId = String(inputRef.docId || "").trim() || createAudioDocId();
    var mime = String(inputRef.mime || "audio/mpeg").trim() || "audio/mpeg";
    var createdAtMs = Number(inputRef.createdAtMs) || nowMs();
    var payload = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    if (!payload.length) throw new Error("Audio payload is empty");
    var details = meta && typeof meta === "object" ? meta : {};
    var fileName = String(details.fileName || "").trim();
    var fileType = String(details.fileType || "").trim();
    var preview = String(details.preview || "").slice(0, 240);

    var db = await this._openDb();
    var tx = db.transaction([STORES.AUDIO_DOCS], "readwrite");
    var store = tx.objectStore(STORES.AUDIO_DOCS);
    store.put({
      docId: docId,
      blob: new Blob([payload], { type: mime }),
      mime: mime,
      createdAtMs: createdAtMs,
      byteLength: payload.length,
      fileName: fileName,
      fileType: fileType,
      preview: preview
    });
    await txDone(tx);

    return {
      docId: docId,
      mime: mime,
      byteLength: payload.length,
      createdAtMs: createdAtMs
    };
  };

  FrameSpoolService.prototype.getTextBytes = async function (docId) {
    var key = String(docId || "").trim();
    if (!key) return null;
    var db = await this._openDb();
    var tx = db.transaction([STORES.TEXT_DOCS], "readonly");
    var store = tx.objectStore(STORES.TEXT_DOCS);
    var record = await requestToPromise(store.get(key));
    await txDone(tx);
    if (!record || !record.blob) return null;
    var buffer = await record.blob.arrayBuffer();
    return new Uint8Array(buffer);
  };

  FrameSpoolService.prototype.getAudioBytes = async function (docId) {
    var key = String(docId || "").trim();
    if (!key) return null;
    var db = await this._openDb();
    var tx = db.transaction([STORES.AUDIO_DOCS], "readonly");
    var store = tx.objectStore(STORES.AUDIO_DOCS);
    var record = await requestToPromise(store.get(key));
    await txDone(tx);
    if (!record || !record.blob) return null;
    var buffer = await record.blob.arrayBuffer();
    return new Uint8Array(buffer);
  };

  FrameSpoolService.prototype.hasTextDoc = async function (docId) {
    var key = String(docId || "").trim();
    if (!key) return false;
    var db = await this._openDb();
    var tx = db.transaction([STORES.TEXT_DOCS], "readonly");
    var store = tx.objectStore(STORES.TEXT_DOCS);
    var record = await requestToPromise(store.get(key));
    await txDone(tx);
    return !!record;
  };

  FrameSpoolService.prototype.hasAudioDoc = async function (docId) {
    var key = String(docId || "").trim();
    if (!key) return false;
    var db = await this._openDb();
    var tx = db.transaction([STORES.AUDIO_DOCS], "readonly");
    var store = tx.objectStore(STORES.AUDIO_DOCS);
    var record = await requestToPromise(store.get(key));
    await txDone(tx);
    return !!record;
  };

  FrameSpoolService.prototype.getTextDocMeta = async function (docId) {
    var key = String(docId || "").trim();
    if (!key) return null;
    var db = await this._openDb();
    var tx = db.transaction([STORES.TEXT_DOCS], "readonly");
    var store = tx.objectStore(STORES.TEXT_DOCS);
    var record = await requestToPromise(store.get(key));
    await txDone(tx);
    if (!record) return null;
    return {
      docId: key,
      mime: String(record.mime || "text/plain"),
      byteLength: Number(record.byteLength) || 0,
      createdAtMs: Number(record.createdAtMs) || 0,
      fileName: String(record.fileName || ""),
      fileType: String(record.fileType || ""),
      preview: String(record.preview || "")
    };
  };

  FrameSpoolService.prototype.getAudioDocMeta = async function (docId) {
    var key = String(docId || "").trim();
    if (!key) return null;
    var db = await this._openDb();
    var tx = db.transaction([STORES.AUDIO_DOCS], "readonly");
    var store = tx.objectStore(STORES.AUDIO_DOCS);
    var record = await requestToPromise(store.get(key));
    await txDone(tx);
    if (!record) return null;
    return {
      docId: key,
      mime: String(record.mime || "audio/mpeg"),
      byteLength: Number(record.byteLength) || 0,
      createdAtMs: Number(record.createdAtMs) || 0,
      fileName: String(record.fileName || ""),
      fileType: String(record.fileType || ""),
      preview: String(record.preview || "")
    };
  };

  FrameSpoolService.prototype.refreshStats = async function () {
    var db = await this._openDb();
    var tx = db.transaction([STORES.FRAME_META], "readonly");
    var store = tx.objectStore(STORES.FRAME_META);
    var frameCount = 0;
    var totalBytes = 0;
    await openCursorAll(store, function (value) {
      frameCount += 1;
      totalBytes += Number((value && value.byteLength) || 0);
    });
    await txDone(tx);
    this.stats.frameCount = frameCount;
    this.stats.totalBytes = totalBytes;
    return {
      frameCount: frameCount,
      totalBytes: totalBytes
    };
  };

  FrameSpoolService.prototype._deleteFrameAndRefs = function (tx, frameId) {
    var frameKey = String(frameId || "").trim();
    if (!frameKey) return;
    tx.objectStore(STORES.FRAMES).delete(frameKey);
    tx.objectStore(STORES.FRAME_META).delete(frameKey);

    var sessionStore = tx.objectStore(STORES.SESSION_REFS);
    var sessionIndex = sessionStore.index("frameId");
    var reportStore = tx.objectStore(STORES.REPORT_REFS);
    var reportIndex = reportStore.index("frameId");

    sessionIndex.openCursor(IDBKeyRange.only(frameKey)).onsuccess = function (event) {
      var cursor = event.target.result;
      if (!cursor) return;
      cursor.delete();
      cursor.continue();
    };
    reportIndex.openCursor(IDBKeyRange.only(frameKey)).onsuccess = function (event) {
      var cursor = event.target.result;
      if (!cursor) return;
      cursor.delete();
      cursor.continue();
    };
  };

  FrameSpoolService.prototype.gc = async function (options) {
    var opts = options || {};
    var orphanMaxAgeMs = Math.max(60 * 1000, Number(opts.orphanMaxAgeMs) || (24 * 60 * 60 * 1000));
    var maxBytes = Math.max(64 * 1024 * 1024, Number(opts.maxBytes) || (1536 * 1024 * 1024));
    var activeSessions = new Set(uniqueStrings(opts.activeSessionIds));

    var db = await this._openDb();
    var txRead = db.transaction([STORES.FRAME_META, STORES.REPORT_REFS, STORES.SESSION_REFS], "readonly");
    var metaStore = txRead.objectStore(STORES.FRAME_META);
    var reportStore = txRead.objectStore(STORES.REPORT_REFS);
    var sessionStore = txRead.objectStore(STORES.SESSION_REFS);

    var metas = [];
    var keepFrameIds = new Set();

    await openCursorAll(metaStore, function (value) {
      if (!value || !value.frameId) return;
      metas.push({
        frameId: String(value.frameId),
        createdAtMs: Number(value.createdAtMs) || 0,
        byteLength: Number(value.byteLength) || 0
      });
    });

    await openCursorAll(reportStore, function (value) {
      if (!value || !value.frameId) return;
      keepFrameIds.add(String(value.frameId));
    });

    var sessionIndex = sessionStore.index("sessionId");
    var sessionTasks = [];
    activeSessions.forEach(function (sessionId) {
      sessionTasks.push(openCursorByIndex(sessionIndex, sessionId, function (value) {
        if (!value || !value.frameId) return;
        keepFrameIds.add(String(value.frameId));
      }));
    });
    await Promise.all(sessionTasks);
    await txDone(txRead);

    var now = nowMs();
    var bytesBefore = metas.reduce(function (sum, item) { return sum + item.byteLength; }, 0);
    var orphanCandidates = metas
      .filter(function (item) {
        if (keepFrameIds.has(item.frameId)) return false;
        return (now - item.createdAtMs) >= orphanMaxAgeMs;
      })
      .sort(function (a, b) { return a.createdAtMs - b.createdAtMs; });

    var dropFrameIds = [];
    var dropFrameIdSet = new Set();
    var bytesPlannedDrop = 0;
    orphanCandidates.forEach(function (item) {
      if (dropFrameIdSet.has(item.frameId)) return;
      dropFrameIds.push(item.frameId);
      dropFrameIdSet.add(item.frameId);
      bytesPlannedDrop += item.byteLength;
    });

    var bytesAfterAgeDrop = Math.max(0, bytesBefore - bytesPlannedDrop);
    if (bytesAfterAgeDrop > maxBytes) {
      var remainingOrphans = metas
        .filter(function (item) {
          return !keepFrameIds.has(item.frameId) && !dropFrameIdSet.has(item.frameId);
        })
        .sort(function (a, b) { return a.createdAtMs - b.createdAtMs; });
      for (var i = 0; i < remainingOrphans.length && bytesAfterAgeDrop > maxBytes; i++) {
        var candidate = remainingOrphans[i];
        if (dropFrameIdSet.has(candidate.frameId)) continue;
        dropFrameIds.push(candidate.frameId);
        dropFrameIdSet.add(candidate.frameId);
        bytesAfterAgeDrop -= candidate.byteLength;
      }
    }

    if (dropFrameIds.length) {
      var txWrite = db.transaction([STORES.FRAMES, STORES.FRAME_META, STORES.SESSION_REFS, STORES.REPORT_REFS], "readwrite");
      for (var j = 0; j < dropFrameIds.length; j++) {
        this._deleteFrameAndRefs(txWrite, dropFrameIds[j]);
      }
      await txDone(txWrite);
    }

    var stats = await this.refreshStats();
    var result = {
      deletedFrameCount: dropFrameIds.length,
      orphanCount: orphanCandidates.length,
      bytesBefore: bytesBefore,
      bytesAfter: stats.totalBytes,
      frameCountAfter: stats.frameCount,
      maxBytes: maxBytes
    };
    this.stats.lastGcAtMs = nowMs();
    this._logEvent("frame-spool:gc", result);
    return result;
  };

  FrameSpoolService.prototype.gcText = async function (options) {
    var opts = options || {};
    var orphanMaxAgeMs = Math.max(60 * 1000, Number(opts.orphanMaxAgeMs) || (24 * 60 * 60 * 1000));
    var maxBytes = Math.max(8 * 1024 * 1024, Number(opts.maxBytes) || (256 * 1024 * 1024));

    var db = await this._openDb();
    var txRead = db.transaction([STORES.TEXT_DOCS, STORES.TEXT_REPORT_REFS], "readonly");
    var docsStore = txRead.objectStore(STORES.TEXT_DOCS);
    var refsStore = txRead.objectStore(STORES.TEXT_REPORT_REFS);

    var docs = [];
    var keepDocIds = new Set();
    await openCursorAll(docsStore, function (value) {
      if (!value || !value.docId) return;
      docs.push({
        docId: String(value.docId),
        createdAtMs: Number(value.createdAtMs) || 0,
        byteLength: Number(value.byteLength) || 0
      });
    });
    await openCursorAll(refsStore, function (value) {
      if (!value || !value.docId) return;
      keepDocIds.add(String(value.docId));
    });
    await txDone(txRead);

    var now = nowMs();
    var bytesBefore = docs.reduce(function (sum, item) { return sum + item.byteLength; }, 0);
    var orphanCandidates = docs
      .filter(function (item) {
        if (keepDocIds.has(item.docId)) return false;
        return (now - item.createdAtMs) >= orphanMaxAgeMs;
      })
      .sort(function (a, b) { return a.createdAtMs - b.createdAtMs; });

    var dropDocIds = [];
    var dropDocIdSet = new Set();
    var bytesPlannedDrop = 0;
    orphanCandidates.forEach(function (item) {
      if (dropDocIdSet.has(item.docId)) return;
      dropDocIds.push(item.docId);
      dropDocIdSet.add(item.docId);
      bytesPlannedDrop += item.byteLength;
    });

    var bytesAfterAgeDrop = Math.max(0, bytesBefore - bytesPlannedDrop);
    if (bytesAfterAgeDrop > maxBytes) {
      var remainingOrphans = docs
        .filter(function (item) {
          return !keepDocIds.has(item.docId) && !dropDocIdSet.has(item.docId);
        })
        .sort(function (a, b) { return a.createdAtMs - b.createdAtMs; });
      for (var i = 0; i < remainingOrphans.length && bytesAfterAgeDrop > maxBytes; i++) {
        var candidate = remainingOrphans[i];
        if (dropDocIdSet.has(candidate.docId)) continue;
        dropDocIds.push(candidate.docId);
        dropDocIdSet.add(candidate.docId);
        bytesAfterAgeDrop -= candidate.byteLength;
      }
    }

    if (dropDocIds.length) {
      var txWrite = db.transaction([STORES.TEXT_DOCS, STORES.TEXT_REPORT_REFS], "readwrite");
      var docsWrite = txWrite.objectStore(STORES.TEXT_DOCS);
      var refsWrite = txWrite.objectStore(STORES.TEXT_REPORT_REFS);
      var refsIdx = refsWrite.index("docId");
      for (var j = 0; j < dropDocIds.length; j++) {
        var docId = dropDocIds[j];
        docsWrite.delete(docId);
        refsIdx.openCursor(IDBKeyRange.only(docId)).onsuccess = function (event) {
          var cursor = event.target.result;
          if (!cursor) return;
          cursor.delete();
          cursor.continue();
        };
      }
      await txDone(txWrite);
    }

    var txStats = db.transaction([STORES.TEXT_DOCS], "readonly");
    var docsStats = txStats.objectStore(STORES.TEXT_DOCS);
    var byteAfter = 0;
    var docCountAfter = 0;
    await openCursorAll(docsStats, function (value) {
      docCountAfter += 1;
      byteAfter += Number((value && value.byteLength) || 0);
    });
    await txDone(txStats);

    return {
      deletedTextDocCount: dropDocIds.length,
      orphanCount: orphanCandidates.length,
      bytesBefore: bytesBefore,
      bytesAfter: byteAfter,
      textDocCountAfter: docCountAfter,
      maxBytes: maxBytes
    };
  };

  FrameSpoolService.prototype.gcAudio = async function (options) {
    var opts = options || {};
    var orphanMaxAgeMs = Math.max(60 * 1000, Number(opts.orphanMaxAgeMs) || (24 * 60 * 60 * 1000));
    var maxBytes = Math.max(8 * 1024 * 1024, Number(opts.maxBytes) || (256 * 1024 * 1024));

    var db = await this._openDb();
    var txRead = db.transaction([STORES.AUDIO_DOCS, STORES.AUDIO_REPORT_REFS], "readonly");
    var docsStore = txRead.objectStore(STORES.AUDIO_DOCS);
    var refsStore = txRead.objectStore(STORES.AUDIO_REPORT_REFS);

    var docs = [];
    var keepDocIds = new Set();
    await openCursorAll(docsStore, function (value) {
      if (!value || !value.docId) return;
      docs.push({
        docId: String(value.docId),
        createdAtMs: Number(value.createdAtMs) || 0,
        byteLength: Number(value.byteLength) || 0
      });
    });
    await openCursorAll(refsStore, function (value) {
      if (!value || !value.docId) return;
      keepDocIds.add(String(value.docId));
    });
    await txDone(txRead);

    var now = nowMs();
    var bytesBefore = docs.reduce(function (sum, item) { return sum + item.byteLength; }, 0);
    var orphanCandidates = docs
      .filter(function (item) {
        if (keepDocIds.has(item.docId)) return false;
        return (now - item.createdAtMs) >= orphanMaxAgeMs;
      })
      .sort(function (a, b) { return a.createdAtMs - b.createdAtMs; });

    var dropDocIds = [];
    var dropDocIdSet = new Set();
    var bytesPlannedDrop = 0;
    orphanCandidates.forEach(function (item) {
      if (dropDocIdSet.has(item.docId)) return;
      dropDocIds.push(item.docId);
      dropDocIdSet.add(item.docId);
      bytesPlannedDrop += item.byteLength;
    });

    var bytesAfterAgeDrop = Math.max(0, bytesBefore - bytesPlannedDrop);
    if (bytesAfterAgeDrop > maxBytes) {
      var remainingOrphans = docs
        .filter(function (item) {
          return !keepDocIds.has(item.docId) && !dropDocIdSet.has(item.docId);
        })
        .sort(function (a, b) { return a.createdAtMs - b.createdAtMs; });
      for (var i = 0; i < remainingOrphans.length && bytesAfterAgeDrop > maxBytes; i++) {
        var candidate = remainingOrphans[i];
        if (dropDocIdSet.has(candidate.docId)) continue;
        dropDocIds.push(candidate.docId);
        dropDocIdSet.add(candidate.docId);
        bytesAfterAgeDrop -= candidate.byteLength;
      }
    }

    if (dropDocIds.length) {
      var txWrite = db.transaction([STORES.AUDIO_DOCS, STORES.AUDIO_REPORT_REFS], "readwrite");
      var docsWrite = txWrite.objectStore(STORES.AUDIO_DOCS);
      var refsWrite = txWrite.objectStore(STORES.AUDIO_REPORT_REFS);
      var refsIdx = refsWrite.index("docId");
      for (var j = 0; j < dropDocIds.length; j++) {
        var docId = dropDocIds[j];
        docsWrite.delete(docId);
        refsIdx.openCursor(IDBKeyRange.only(docId)).onsuccess = function (event) {
          var cursor = event.target.result;
          if (!cursor) return;
          cursor.delete();
          cursor.continue();
        };
      }
      await txDone(txWrite);
    }

    var txStats = db.transaction([STORES.AUDIO_DOCS], "readonly");
    var docsStats = txStats.objectStore(STORES.AUDIO_DOCS);
    var byteAfter = 0;
    var docCountAfter = 0;
    await openCursorAll(docsStats, function (value) {
      docCountAfter += 1;
      byteAfter += Number((value && value.byteLength) || 0);
    });
    await txDone(txStats);

    return {
      deletedAudioDocCount: dropDocIds.length,
      orphanCount: orphanCandidates.length,
      bytesBefore: bytesBefore,
      bytesAfter: byteAfter,
      audioDocCountAfter: docCountAfter,
      maxBytes: maxBytes
    };
  };

  FrameSpoolService.prototype.close = async function () {
    if (this._closed) return;
    var db = null;
    try { db = await this._openDb(); } catch (_) { db = null; }
    this._closed = true;
    if (db) {
      try { db.close(); } catch (_) {}
    }
    this._dbPromise = null;
    this.captureQueue.length = 0;
    this.processQueue.length = 0;
    this.writeQueue.length = 0;
  };

  global.UIRFrameSpool = {
    DB_NAME: DB_NAME,
    DB_VERSION: DB_VERSION,
    STORES: STORES,
    createService: function (options) {
      return new FrameSpoolService(options || {});
    },
    dataUrlToBlob: dataUrlToBlob,
    bytesToDataUrl: bytesToDataUrl
  };
})(typeof self !== "undefined" ? self : window);
